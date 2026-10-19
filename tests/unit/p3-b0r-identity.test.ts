import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COVERAGE_FLOORS,
  encodeRandomCorpus,
  FAMILIES,
  FAMILY_PATHS,
  generateRandomCorpus,
  maxCubicSides,
  RANDOM_SEED,
  SOURCE_CAPS,
  ulpStep,
  withinSourceCaps,
  Xorshift32,
} from '../geometry/p3-b0r/corpus.js';
import { Xorshift32 as B0Xorshift32 } from '../geometry/p3-b0/corpus.js';
import { encodeLadderCorpus, LADDER_FAMILY } from '../geometry/p3-fill-ladder/corpus.js';
import {
  applyOracleValidation,
  changedPaths,
  checkRevisions,
  checkTestFileChanges,
  classifyRevisionChange,
  compareDigests,
  compareInlineTestModules,
  compareWasmToNative,
  familyOf,
  inlineTestModules,
  isCapFailure,
  LADDER_CORPUS_SHA256,
  missedFloors,
  nativeCascadeName,
  packFillInput,
  parseArguments,
  parseNativeDigests,
  parseRungRecord,
  RANDOM_CORPUS_SHA256,
  randomCoverage,
  revisionManifest,
  revisionSelfCheck,
  rungPathOf,
  selectWasmRandomPaths,
  tamper,
  WASM_RANDOM_PATHS,
  WASM_STRATUM_PATHS,
  type DigestEntry,
  type RevisionChangeInput,
} from '../../tooling/compare-p3-fill-identity.mjs';

// The tool pins the corpus SHA-256 and refuses a run on mismatch (contract section 7: the
// SHA-256 of `p3-b0r-random/v1` is recorded in the U0 PR; families and counts do not change).

const digest = (fill: string) => fill.repeat(64);
const entry = (code: string, crossings = 0, fill = 'a'): DigestEntry => ({
  digest: digest(fill),
  allocations: 0,
  code,
  crossings,
});

describe('B0R randomized corpus p3-b0r-random/v1', () => {
  const corpus = generateRandomCorpus();

  it('has six families of 2,000 paths in the contract order', () => {
    expect(corpus.map(({ family }) => family.id)).toEqual(FAMILIES.map((family) => family.id));
    expect(corpus).toHaveLength(6);
    for (const { paths } of corpus) expect(paths).toHaveLength(FAMILY_PATHS);
  });

  it('keeps every path within the source caps with finite scalars', () => {
    for (const { paths } of corpus)
      for (const path of paths) {
        expect(withinSourceCaps(path)).toBe(true);
        expect([0, 1]).toContain(path.rule);
        expect(path.exponent).toBeGreaterThanOrEqual(-1021);
        expect(path.exponent).toBeLessThanOrEqual(1023);
      }
    expect(maxCubicSides(1)).toBe(16);
    expect(maxCubicSides(2)).toBe(8);
    expect(maxCubicSides(4)).toBe(4);
    expect(SOURCE_CAPS).toEqual({ verbs: 24, scalars: 104, contours: 4, segments: 16 });
  });

  it('is deterministic and matches its pinned SHA-256', () => {
    const bytes = encodeRandomCorpus(corpus);
    expect(Buffer.from(encodeRandomCorpus()).equals(Buffer.from(bytes))).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(RANDOM_CORPUS_SHA256);
  });

  it('uses the B0 xorshift32 (13, 17, 5) from seed 0x42305231', () => {
    expect(RANDOM_SEED).toBe(0x42305231);
    const ours = new Xorshift32(RANDOM_SEED);
    const b0 = new B0Xorshift32(RANDOM_SEED);
    for (let index = 0; index < 100; index += 1) expect(ours.next()).toBe(b0.next());
  });

  it('steps one ulp in either direction, including through zero', () => {
    expect(ulpStep(1, 1)).toBe(1 + Number.EPSILON);
    expect(ulpStep(1, -1)).toBe(1 - Number.EPSILON / 2);
    expect(ulpStep(-1, 1)).toBe(-1 + Number.EPSILON / 2);
    expect(ulpStep(0, -1)).toBe(-Number.MIN_VALUE);
  });
});

describe('B0R identity tool helpers', () => {
  it('extracts inline test modules up to the brace at the mod indentation', () => {
    const source = [
      'fn a() {}',
      '#[cfg(test)]',
      'mod declared;',
      '#[cfg(test)]',
      '#[allow(dead_code)]',
      'mod tests {',
      '    fn b() {',
      '        let _ = "}";',
      '    }',
      '}',
      'fn c() {}',
      '#[cfg(test)]',
      'impl X {',
      '}',
    ].join('\n');
    const modules = inlineTestModules(source);
    expect([...modules.keys()]).toEqual(['tests']);
    expect(modules.get('tests')).toBe(
      [
        '#[cfg(test)]',
        '#[allow(dead_code)]',
        'mod tests {',
        '    fn b() {',
        '        let _ = "}";',
        '    }',
        '}',
      ].join('\n'),
    );
  });

  it('accepts changes outside test modules and rejects any change inside', () => {
    const base = 'fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() {}\n}\n';
    expect(compareInlineTestModules('x.rs', base, `fn a() { 1; }\n${base.slice(10)}`)).toEqual([]);
    expect(compareInlineTestModules('x.rs', base, base.replace('fn t() {}', 'fn t() { }'))).toEqual(
      ['x.rs: inline test module tests differs from the merge base'],
    );
    expect(compareInlineTestModules('x.rs', base, 'fn a() {}\n')).toEqual([
      'x.rs: inline test module tests removed',
    ]);
    expect(compareInlineTestModules('x.rs', 'fn a() {}\n', base)).toEqual([
      'x.rs: inline test module tests added',
    ]);
  });

  it('parses digest lines and reports one tampered digest by name', () => {
    const text = [
      `rnd/F1/0000/attempt\t${digest('a')}\t0\tOK\t0`,
      `rnd/F1/0000/fill_v0_cascade\t${digest('b')}\t0\tpath_status=0\t0`,
      `b0/P2/s=3/0000/attempt\t${digest('c')}\t0\tTopology(KnotMismatch)\t0`,
      '',
    ].join('\n');
    const base = parseNativeDigests(text);
    expect(base.size).toBe(3);
    expect(compareDigests(base, parseNativeDigests(text)).equal).toBe(true);
    const tampered = tamper(base, 'rnd/F1/0000/fill_v0_cascade');
    const comparison = compareDigests(base, tampered);
    expect(comparison.equal).toBe(false);
    expect(comparison.differing).toEqual(['rnd/F1/0000/fill_v0_cascade']);
    const shorter = new Map(base);
    shorter.delete('b0/P2/s=3/0000/attempt');
    expect(compareDigests(base, shorter).missing).toEqual(['b0/P2/s=3/0000/attempt']);
    expect(compareDigests(shorter, base).extra).toEqual(['b0/P2/s=3/0000/attempt']);
    expect(() => parseNativeDigests(`x\tnothex\t0\tOK\t0`)).toThrow(/Malformed/u);
    expect(() => tamper(base, 'unknown')).toThrow(/unknown case/u);
  });

  it('classifies cap failures and counts coverage once per path', () => {
    for (const code of [
      'CommandLimit',
      'OwnerLimit',
      'Rounded(NodeLimit)',
      'Rounded(WorkLimit)',
      'Topology(WorkLimit)',
      'NO_MESH(flat_status=5)',
      'path_status=5',
    ])
      expect(isCapFailure(code)).toBe(true);
    for (const code of ['OK', 'Topology(Unresolved)', 'NO_MESH(flat_status=4)', 'path_status=6'])
      expect(isCapFailure(code)).toBe(false);
    const cases = new Map<string, DigestEntry>([
      ['rnd/F4/0000/attempt', entry('Topology(Unresolved)')],
      ['rnd/F4/0000/attempt_triangle_free', entry('OK', 3)],
      ['rnd/F4/0000/fill_v0_cascade', entry('path_status=0', 3)],
      ['rnd/F1/0001/attempt', entry('Topology(KnotMismatch)')],
      ['rnd/F1/0001/fill_v0_cascade', entry('path_status=5')],
      ['b0/P2/s=3/0000/attempt', entry('OK')],
    ]);
    const { counts } = randomCoverage(cases);
    expect(counts).toEqual({
      paths: 2,
      ok: 1,
      knotMismatch: 1,
      unresolved: 1,
      capFailure: 1,
      okWithCrossings: 1,
    });
    expect(missedFloors(counts, COVERAGE_FLOORS)).toHaveLength(5);
    expect(missedFloors({ ...counts, ok: 1_000 }, { ok: 1_000 })).toEqual([]);
  });

  it('selects the literal first 2,000 paths plus a stratified superset for WASM', () => {
    const corpus = generateRandomCorpus();
    const crossing = new Set(['F4-star-wave/3', 'F4-star-wave/1999']);
    const selection = selectWasmRandomPaths(corpus, crossing);
    const byFamily = new Map<string, typeof selection>();
    for (const item of selection)
      byFamily.set(item.family, [...(byFamily.get(item.family) ?? []), item]);
    expect(selection.filter((item) => item.reason === 'first')).toHaveLength(WASM_RANDOM_PATHS);
    expect(byFamily.get('F1-generic-rings')).toHaveLength(FAMILY_PATHS);
    for (const family of FAMILIES.slice(1))
      expect(byFamily.get(family.id)!.length).toBeGreaterThanOrEqual(WASM_STRATUM_PATHS);
    const f4 = byFamily.get('F4-star-wave')!;
    expect(f4.filter((item) => item.reason === 'crossing').map((item) => item.index)).toEqual([
      3, 1999,
    ]);
    const f5 = corpus[4]!.paths;
    const picked = new Set(byFamily.get('F5-near-degenerate')!.map((item) => item.index));
    f5.forEach((path, index) => {
      const magnitude = Math.max(...path.points.map(Math.abs));
      if (path.exponent !== -3 || magnitude < 2 ** -20 || magnitude > 2 ** 30)
        expect(picked.has(index)).toBe(true);
    });
    expect(nativeCascadeName('wasm/rnd/F4-star-wave/0003')).toBe(
      'rnd/F4-star-wave/0003/fill_v0_cascade',
    );
    expect(nativeCascadeName('wasm/b0/P2/s=3/0000')).toBe('b0/P2/s=3/0000/fill_v0_cascade');
    const native = new Map([['b0/P2/s=3/0000/fill_v0_cascade', entry('path_status=0')]]);
    expect(compareWasmToNative(new Map([['wasm/b0/P2/s=3/0000', entry('x')]]), native).equal).toBe(
      true,
    );
    const changed = compareWasmToNative(
      new Map([['wasm/b0/P2/s=3/0000', entry('x', 0, 'b')]]),
      native,
    );
    expect(changed.differing).toEqual(['wasm/b0/P2/s=3/0000']);
    expect(compareWasmToNative(new Map([['wasm/b0/X/0001', entry('x')]]), native).missing).toEqual([
      'wasm/b0/X/0001',
    ]);
  });

  it('packs one fill-v0 path with the section a layout', () => {
    const bytes = packFillInput([0, 1, 1, 3], [0, 0, 1, 0, 0, 1], 1, -3, 7);
    const view = new DataView(bytes.buffer);
    const header = Array.from({ length: 12 }, (_, index) => view.getUint32(index * 4, true));
    expect(header).toEqual([0x30464756, 0, 136, 1, 4, 6, 48, 64, 72, 80, 88, 0]);
    expect(bytes.length).toBe(136);
    expect([view.getUint32(48, true), view.getUint32(52, true), view.getInt32(56, true)]).toEqual([
      7, 1, -3,
    ]);
    expect(view.getFloat64(88 + 16, true)).toBe(1);
  });
});

// Alt-A1 unit AL-U2 (docs/plans/p3-alt-a1-fill-ladder-contract.md section 4.4): the reviewed
// test-file allow-list, the revision check and the `--revision-change` classification and
// manifest, tested on synthetic digest and rung files before AL-U3 needs them.

/** Native and WASM digests of one case per class, and the branch's rung record. */
function revisionInput(): RevisionChangeInput {
  const map = (rows: readonly (readonly [string, string, string])[]) =>
    new Map(rows.map(([name, fill, code]) => [name, entry(code, 0, fill)]));
  const cascade = (path: string) => `${path}/fill_v0_cascade`;
  const paths = ['rnd/T/0000', 'rnd/T/0001', 'b0/P2/s=3/0000', 'b0/O1/P2/s=3/0000'];
  const base: [string, string, string][] = [
    [paths[0]!, 'c', 'path_status=0'],
    [paths[1]!, 'd', 'path_status=0'],
    [paths[2]!, 'e', 'path_status=0'],
    [paths[3]!, '1', 'path_status=6'],
  ];
  const branch: [string, string, string][] = [
    [paths[0]!, 'c', 'path_status=0'],
    [paths[1]!, 'd', 'path_status=0'],
    [paths[2]!, 'f', 'path_status=0'],
    [paths[3]!, '2', 'path_status=0'],
  ];
  const entries: [string, string, string][] = [
    ['meta/cubic-workspace-sizes', 'a', 'META'],
    ['meta/fill-engine-sizes', 'a', 'META'],
    ['rnd/T/0000/attempt', 'b', 'OK'],
  ];
  const native = (rows: [string, string, string][]) =>
    map([...entries, ...rows.map(([path, fill, code]) => [cascade(path), fill, code] as const)]);
  const wasm = (rows: [string, string, string][]) =>
    map(rows.map(([path, fill, code]) => [`wasm/${path}`, fill, code] as const));
  return {
    native: { base: native(base), branch: native(branch) },
    wasm: { base: wasm(base), branch: wasm(branch) },
    rungs: parseRungRecord(
      [
        'rnd/T/0000\t1\tCROSSING\tLegacy\tOk(flat_status=0)',
        'rnd/T/0001\t0\t-\t-\t-',
        'b0/P2/s=3/0000\t0\t-\t-\t-',
        'b0/O1/P2/s=3/0000\t0\t-\t-\t-',
        '',
      ].join('\n'),
    ),
  };
}

describe('Alt-A1 AL-U2 identity tooling', () => {
  it('parses the repeatable allow-list and the revision-change and self-test flags', () => {
    expect(
      parseArguments([
        '--allow-test-change',
        'tests/unit/p3-b0r-identity.test.ts',
        '--revision-change',
        '--allow-test-change',
        'tests\\geometry\\fill-adapter.test.ts',
        '--threads',
        '4',
      ]),
    ).toEqual({
      base: null,
      threads: 4,
      compareOnly: null,
      tamper: null,
      allowTestChanges: [
        'tests/unit/p3-b0r-identity.test.ts',
        'tests/geometry/fill-adapter.test.ts',
      ],
      revisionChange: true,
      selfTest: false,
    });
    expect(parseArguments(['--self-test']).selfTest).toBe(true);
    expect(() => parseArguments(['--self-test', '--revision-change'])).toThrow(/no other/u);
    expect(() => parseArguments(['--allow-test-change'])).toThrow(/needs a value/u);
    expect(() => parseArguments(['--allow-test-change', 'a', '--allow-test-change', 'a'])).toThrow(
      /twice/u,
    );
    expect(() => parseArguments(['--tamper', 'x'])).toThrow(/compare-only/u);
    expect(() => parseArguments(['--unknown', 'x'])).toThrow(/Unknown/u);
  });

  it('allows exactly the listed changed test files, logged by their diff lines', () => {
    const listing = [
      'M\ttests/unit/p3-b0r-identity.test.ts',
      'A\ttests/geometry/p3-fill-ladder-oracle.test.ts',
      'R087\ttests/geometry/old.test.ts\ttests/geometry/new.test.ts',
    ];
    expect(
      checkTestFileChanges(listing, [
        'tests/unit/p3-b0r-identity.test.ts',
        'tests/geometry/old.test.ts',
      ]),
    ).toEqual({ allowed: [listing[0], listing[2]], failures: [] });
    // A changed file that is not listed fails, and so does a listed file that did not change.
    expect(
      checkTestFileChanges(listing, ['tests/unit/p3-b0r-identity.test.ts', 'tests/x.test.ts']),
    ).toEqual({
      allowed: [listing[0]],
      failures: [
        `existing test file changed: ${listing[2]}`,
        'allow-listed test file not changed: tests/x.test.ts',
      ],
    });
    expect(checkTestFileChanges([listing[1]!], []).failures).toEqual([]);
  });

  it('requires equal revisions in plain mode and base + 1 with --revision-change', () => {
    expect(checkRevisions(1, 1, false)).toEqual([]);
    expect(checkRevisions(2, 2, false)).toEqual([]);
    expect(checkRevisions(1, 2, false)).toHaveLength(1);
    expect(checkRevisions(1, 2, true)).toEqual([]);
    // Failing control: a revision that is not base + 1.
    expect(checkRevisions(1, 1, true)).toEqual([
      'revision-change mode needs branch revision 2, found 1',
    ]);
    expect(checkRevisions(1, 3, true)).toHaveLength(1);
  });

  it('classifies one case of each class and writes a counted, hashed manifest', () => {
    const { cases, failures, metaDiffering } = classifyRevisionChange(revisionInput());
    expect(failures).toEqual([]);
    expect(metaDiffering).toEqual([]);
    expect(cases.map((item) => [item.case, item.class, item.oldStatus, item.reason])).toEqual([
      ['rnd/T/0000/fill_v0_cascade', 'unchanged', 'path_status=0', 'CROSSING'],
      ['rnd/T/0001/fill_v0_cascade', 'fast-identical', 'path_status=0', '-'],
      ['b0/P2/s=3/0000/fill_v0_cascade', 'changed-fast', 'path_status=0', '-'],
      ['b0/O1/P2/s=3/0000/fill_v0_cascade', 'newly-admitted', 'path_status=6', '-'],
      ['wasm/rnd/T/0000', 'unchanged', 'path_status=0', 'CROSSING'],
      ['wasm/rnd/T/0001', 'fast-identical', 'path_status=0', '-'],
      ['wasm/b0/P2/s=3/0000', 'changed-fast', 'path_status=0', '-'],
      ['wasm/b0/O1/P2/s=3/0000', 'newly-admitted', 'path_status=6', '-'],
    ]);
    const manifest = revisionManifest(cases);
    expect(manifest.text.split('\n')[3]).toBe(
      'b0/O1/P2/s=3/0000/fill_v0_cascade\tnewly-admitted\tpath_status=6\t-',
    );
    expect(manifest.sha256).toBe(createHash('sha256').update(manifest.text).digest('hex'));
    expect(revisionManifest(classifyRevisionChange(revisionInput()).cases).sha256).toBe(
      manifest.sha256,
    );
    expect(manifest.counts['native rnd/T']).toEqual({
      unchanged: 1,
      'fast-identical': 1,
      'changed-fast': 0,
      'newly-admitted': 0,
    });
    expect(manifest.counts['wasm b0/O1']!['newly-admitted']).toBe(1);
    expect(rungPathOf('rnd/T/0000/attempt')).toBeNull();
    expect(familyOf('b0/O1/P2/s=3/0000')).toBe('b0/O1');
    // Every changed class is validated by the oracles: fast, with no SL-O1 or SL-O2 failure.
    const changed = changedPaths(cases);
    expect(changed).toEqual(['rnd/T/0001', 'b0/P2/s=3/0000', 'b0/O1/P2/s=3/0000']);
    const validation = new Map<string, { rung: string; failures: string[] }>(
      changed.map((path) => [path, { rung: 'fast', failures: [] }]),
    );
    expect(applyOracleValidation(cases, validation)).toEqual([]);
    validation.delete('rnd/T/0001');
    validation.set('b0/P2/s=3/0000', { rung: 'fast', failures: ['SL-O2: item 3: chain'] });
    validation.set('b0/O1/P2/s=3/0000', { rung: 'fallback', failures: [] });
    expect(applyOracleValidation(cases, validation)).toEqual([
      'rnd/T/0001: not validated by the oracles',
      'b0/P2/s=3/0000: SL-O2: item 3: chain',
      'b0/O1/P2/s=3/0000: the dump took rung fallback',
    ]);
  });

  it('fails a rung-1 change, a missing rung, a changed case marked rung 1 and an entry change', () => {
    // A rung-1 case whose bytes differ.
    const differing = revisionInput();
    differing.native.branch = tamper(differing.native.branch, 'rnd/T/0000/fill_v0_cascade');
    expect(classifyRevisionChange(differing).failures).toEqual([
      'rnd/T/0000/fill_v0_cascade: rung 1 but the bytes differ from the merge base (path_status=0 -> path_status=0)',
    ]);
    // A case missing from the rung record.
    const missing = revisionInput();
    missing.rungs.delete('b0/P2/s=3/0000');
    expect(classifyRevisionChange(missing).failures).toEqual([
      'b0/P2/s=3/0000/fill_v0_cascade: path b0/P2/s=3/0000 missing from the rung record',
      'wasm/b0/P2/s=3/0000: path b0/P2/s=3/0000 missing from the rung record',
    ]);
    // A changed case marked rung 1: the newly admitted path recorded as a fallback.
    const marked = revisionInput();
    marked.rungs.set('b0/O1/P2/s=3/0000', {
      rung: 1,
      reason: 'CLOSURE',
      step: 'Legacy',
      exact: 'Topology(KnotMismatch)',
    });
    expect(classifyRevisionChange(marked).failures).toEqual([
      'b0/O1/P2/s=3/0000/fill_v0_cascade: rung 1 but the bytes differ from the merge base (path_status=6 -> path_status=0)',
      'wasm/b0/O1/P2/s=3/0000: rung 1 but the bytes differ from the merge base (path_status=6 -> path_status=0)',
    ]);
    // An exact entry and the cubic-workspace sizes changed (AL-I1), a rung-0 case that is not
    // ok and a lost case; only the fill-engine sizes are recorded, not failed.
    const entries = revisionInput();
    entries.native.branch = tamper(
      tamper(tamper(entries.native.branch, 'rnd/T/0000/attempt'), 'meta/cubic-workspace-sizes'),
      'meta/fill-engine-sizes',
    );
    entries.native.branch.set('rnd/T/0001/fill_v0_cascade', entry('path_status=6', 0, '9'));
    entries.wasm.branch.delete('wasm/rnd/T/0001');
    const result = classifyRevisionChange(entries);
    expect(result.failures).toEqual([
      'AL-I1: entry case meta/cubic-workspace-sizes differs from the merge base',
      'AL-I1: entry case rnd/T/0000/attempt differs from the merge base',
      'rnd/T/0001/fill_v0_cascade: rung 0 but the branch status is path_status=6',
      'wasm: case wasm/rnd/T/0001 missing on the branch',
    ]);
    expect(result.metaDiffering).toEqual(['meta/fill-engine-sizes']);
    expect(() => parseRungRecord('x\t0\tCLOSURE\t-\t-')).toThrow(/disagree/u);
    expect(() => parseRungRecord('x\t2\t-\t-\t-')).toThrow(/Malformed/u);
  });

  it('detects the seeded unexpected change of the self-check', () => {
    expect(revisionSelfCheck(revisionInput(), 'rnd/T/0000/fill_v0_cascade')).toEqual({
      case: 'rnd/T/0000/fill_v0_cascade',
      detected: true,
    });
    expect(revisionSelfCheck(revisionInput(), 'wasm/rnd/T/0000').detected).toBe(true);
  });

  it('pins p3-fill-ladder-random/v1 in the B0R frame', () => {
    expect(LADDER_FAMILY.id).toBe('L1-generic-ladder');
    expect(createHash('sha256').update(encodeLadderCorpus()).digest('hex')).toBe(
      LADDER_CORPUS_SHA256,
    );
  });
});
