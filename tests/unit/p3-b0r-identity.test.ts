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
import {
  compareDigests,
  compareInlineTestModules,
  compareWasmToNative,
  inlineTestModules,
  isCapFailure,
  missedFloors,
  nativeCascadeName,
  packFillInput,
  parseNativeDigests,
  RANDOM_CORPUS_SHA256,
  randomCoverage,
  selectWasmRandomPaths,
  tamper,
  WASM_RANDOM_PATHS,
  WASM_STRATUM_PATHS,
  type DigestEntry,
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
