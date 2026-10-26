// X1: the A05/A06 evidence map and its evaluation, without running the mapped tests. The run over
// the mapped tests is `pnpm p3-exit:a05-a06`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkMap,
  evaluate,
  findSnapshotRecord,
  identityMismatches,
  parseCargoTests,
  renderMarkdown,
  vitestTests,
  type EvidenceMap,
} from '../../tooling/p3-exit-a05-a06.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
const map = JSON.parse(read('tooling/p3-exit-a05-a06-map.json')) as EvidenceMap;
const io = { exists: (p: string) => existsSync(path.join(root, p)), read };

/** The file's source and the shared suites it imports from tests/support. */
function sources(file: string): string {
  const text = read(file);
  const support = [...text.matchAll(/from '\.\.\/support\/([\w-]+)\.js'/gu)].map((m) =>
    read(`tests/support/${m[1]}.ts`),
  );
  return [text, ...support].join('\n');
}

describe('p3-exit A05/A06 map', () => {
  it('passes its own structure check', () => {
    expect(checkMap(map, io)).toEqual([]);
  });

  it('names a test title literally for every each prefix, so a renamed test fails here first', () => {
    const missing: string[] = [];
    for (const entry of [...map.criteria.A05!, ...map.criteria.A06!]) {
      if (!entry.each || !entry.file) continue;
      const text = sources(entry.file);
      for (const prefix of entry.each)
        if (![`'${prefix}`, `\`${prefix}`].some((open) => text.includes(open)))
          missing.push(`${entry.id}: ${prefix}`);
    }
    expect(missing).toEqual([]);
  });

  it('names every fixture set of E11 section 7 rows A05 and A06', () => {
    const ids = (c: 'A05' | 'A06') =>
      map.criteria[c]!.filter((e) => e.kind !== 'supplementary').map((e) => e.id);
    expect(ids('A05')).toEqual([
      'V2-A3',
      'V2-A5',
      'C01-C18 (release WASM)',
      'C01-C18 (test double)',
      'SC01-SC22 (release WASM)',
      'SC01-SC22 (test double)',
    ]);
    expect(ids('A06')).toEqual([
      'V3-A2',
      'V3-A3',
      'V3-A5 (pipeline)',
      'V3-A5 (buckets)',
      'V3-A6',
      'V3-A7',
      'B2 section 9.3 (stroke key, shared cache and memo, reuse)',
      'V-3 port-call deltas (VZ3-A4, A5, A6, A10, A11, A12)',
    ]);
  });

  it('rejects a missing file, an unknown kernel module and a mismatched headed kind', () => {
    const broken: EvidenceMap = {
      ...map,
      criteria: {
        A05: [
          {
            id: 'a',
            source: map.contract.split('#')[0]!,
            kind: 'required',
            runner: 'unit',
            file: 'x.ts',
          },
          {
            id: 'b',
            source: map.contract.split('#')[0]!,
            kind: 'required',
            runner: 'cargo',
            filter: 'nope_tests::',
          },
        ],
        A06: [
          {
            id: 'c',
            source: map.contract.split('#')[0]!,
            kind: 'headed',
            runner: 'unit',
            file: 'x.ts',
          },
        ],
      },
    };
    expect(checkMap(broken, io)).toEqual([
      'A05 a: file x.ts is missing',
      'A05 b: kernel has no module nope_tests',
      'A06 c: kind headed and runner headed go together',
      'A06 c: file x.ts is missing',
    ]);
  });
});

describe('p3-exit A05/A06 evaluation', () => {
  const small: EvidenceMap = {
    version: 'p3-exit-a05-a06-map/v1',
    contract: 'c',
    criteria: {
      A05: [
        { id: 'k', source: 's', kind: 'required', runner: 'cargo', filter: 'm_tests::' },
        {
          id: 'u',
          source: 's',
          kind: 'required',
          runner: 'unit',
          file: 'f.ts',
          each: ['C01 ', 'C02 '],
        },
        { id: 'x', source: 's', kind: 'supplementary', runner: 'unit', file: 'g.ts' },
      ],
      A06: [{ id: 'h', source: 's', kind: 'headed', runner: 'headed', file: 'p.spec.ts' }],
    },
  };

  it('passes when every selected test passed and every prefix matched', () => {
    const result = evaluate(small, {
      cargo: { ok: true, tests: [{ name: 'm_tests::a', status: 'passed' }] },
      unit: {
        ok: true,
        tests: [
          { file: 'f.ts', title: 'C01 one', status: 'passed' },
          { file: 'f.ts', title: 'C02 two', status: 'passed' },
          { file: 'f.ts', title: 'C03 other', status: 'failed' },
          { file: 'g.ts', title: 'any', status: 'failed' },
        ],
      },
    });
    expect(result.rows.map((r) => [r.entry.id, r.verdict, r.selected])).toEqual([
      ['k', 'PASS', 1],
      ['u', 'PASS', 2],
      ['x', 'FAIL', 1],
      ['h', 'HEADED', 0],
    ]);
    expect(result.criteria).toEqual({
      A05: 'PASS',
      A06: 'PASS (CI part; headed part cited separately)',
    });
  });

  it('fails on a skipped test, an unmatched prefix, an empty selection or a failed run', () => {
    const result = evaluate(small, {
      cargo: { ok: false, tests: [] },
      unit: { ok: true, tests: [{ file: 'f.ts', title: 'C01 one', status: 'skipped' }] },
    });
    expect(result.rows[0]!.failures).toEqual(['cargo run failed']);
    expect(result.rows[1]!.failures).toEqual(['C01 one: skipped', 'no test titled "C02..."']);
    expect(result.criteria.A05).toBe('FAIL');
  });

  it('parses libtest lines and flattens a Vitest JSON report to repository paths', () => {
    expect(
      parseCargoTests(
        'running 2 tests\ntest m_tests::a ... ok\ntest m_tests::b ... FAILED\r\ntest m_tests::c ... ignored\n',
      ),
    ).toEqual([
      { name: 'm_tests::a', status: 'passed' },
      { name: 'm_tests::b', status: 'FAILED' },
      { name: 'm_tests::c', status: 'ignored' },
    ]);
    expect(
      vitestTests(
        {
          testResults: [
            {
              name: 'D:\\GIT\\repo\\tests\\unit\\f.test.ts',
              assertionResults: [{ title: 't', fullName: 'd t', status: 'passed' }],
            },
          ],
        },
        'D:\\GIT\\repo',
      ),
    ).toEqual([{ file: 'tests/unit/f.test.ts', title: 't', fullName: 'd t', status: 'passed' }]);
  });

  it('renders the label, the identities and one row per entry', () => {
    const text = renderMarkdown(
      evaluate(small, {
        cargo: { ok: true, tests: [{ name: 'm_tests::a', status: 'passed' }] },
        unit: { ok: true, tests: [] },
      }),
      { label: 'PRE-FREEZE', identities: { 'Run commit': 'abc' } },
    );
    expect(text).toContain('Label: **PRE-FREEZE**');
    expect(text).toContain('| Run commit | abc |');
    expect(text).toContain(
      '| A05 | u | required | unit | 0 | FAIL: no test selected; no test titled "C01..."; no test titled "C02..." |',
    );
  });

  it('finds no snapshot record in the current E11 contract, whose defining sentence does not count', () => {
    const contract = read('docs/plans/d9-e11-p3-c03-c05-closure-contract.md');
    expect(contract).toContain('**Exit snapshot record**');
    expect(findSnapshotRecord(contract, 'abcdef1').error).toMatch(/no dated/u);
  });

  it('finds a dated record by its commit and checks the identities against its block', () => {
    const contract = [
      '## 3.2',
      'A dated "**Exit snapshot record**" line is appended.',
      '- **Exit snapshot record** 2026-11-01, commit `abcdef1234567890`:',
      '  `geometry-wasm/fill-v0+r3`, `geometry-wasm/stroke-v0+r7`, WASM `AA11`',
      '## 4',
      'geometry-wasm/stroke-v0+r6',
    ].join('\n');
    expect(findSnapshotRecord(contract, 'abcdef2').error).toBeDefined();
    const { block } = findSnapshotRecord(contract, 'abcdef1');
    expect(block).toContain('stroke-v0+r7');
    expect(block).not.toContain('## 4');
    const identities = {
      'Fill operation': 'geometry-wasm/fill-v0+r3',
      'Stroke operation': 'geometry-wasm/stroke-v0+r6',
      'Release WASM SHA-256': 'aa11',
    };
    expect(identityMismatches(block!, identities)).toEqual([
      'Stroke operation geometry-wasm/stroke-v0+r6 is not in the snapshot record',
    ]);
    expect(
      identityMismatches('`geometry-wasm/fill-v0+r30`', {
        'Fill operation': 'geometry-wasm/fill-v0+r3',
      })[0],
    ).toMatch(/^Fill operation/u);
  });

  it('strips a Windows root whose drive letter differs in case', () => {
    expect(
      vitestTests(
        {
          testResults: [
            {
              name: 'd:/GIT/repo/tests/unit/f.test.ts',
              assertionResults: [{ title: 't', fullName: 't', status: 'passed' }],
            },
          ],
        },
        'D:\\GIT\\repo',
      )[0]!.file,
    ).toBe('tests/unit/f.test.ts');
  });
});
