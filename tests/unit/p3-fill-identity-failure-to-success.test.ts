import { describe, expect, it } from 'vitest';
import {
  type DigestEntry,
  classifyFailureToSuccess,
  classifyOutcome,
  failureToSuccessTamperChecks,
  parseArguments,
} from '../../tooling/compare-p3-fill-identity.mjs';

// E8-U0 (docs/plans/p3-rounded-knot-topology-contract.md section E8.2a): the
// `--failure-to-success` classification. The tool's own `--self-test` covers the tamper cases
// end to end; these tests pin the pure helpers.

const digest = (fill: string): string => fill.repeat(64);
const record = (fill: string, code: string, allocations = 0, crossings = 0): DigestEntry => ({
  digest: digest(fill),
  allocations,
  code,
  crossings,
});

function input(branchChange: (native: Map<string, DigestEntry>) => void) {
  const base = (): Map<string, DigestEntry> =>
    new Map([
      ['a', record('a', 'path_status=0')],
      ['b', record('b', 'path_status=5')],
    ]);
  const native = { base: base(), branch: base() };
  branchChange(native.branch);
  return { native, wasm: { base: new Map(), branch: new Map() } };
}

describe('E8-U0 failure-to-success identity mode', () => {
  it('parses --failure-to-success, alone or combined with --revision-change (E14-G1)', () => {
    expect(parseArguments(['--failure-to-success']).failureToSuccess).toBe(true);
    expect(parseArguments([]).failureToSuccess).toBeUndefined();
    const combined = parseArguments(['--failure-to-success', '--revision-change']);
    expect(combined.failureToSuccess).toBe(true);
    expect(combined.revisionChange).toBe(true);
  });

  it('classifies outcome codes by the fill-v0 port mapping', () => {
    expect(classifyOutcome('OK')).toBe('ok');
    expect(classifyOutcome('path_status=0')).toBe('ok');
    expect(classifyOutcome('path_status=6')).toBe('path-failure');
    expect(classifyOutcome('Topology(KnotMismatch)')).toBe('path-failure');
    expect(classifyOutcome('NO_MESH(flat_status=5)')).toBe('path-failure');
    expect(classifyOutcome('Rounded(InternalInvariant)')).toBe('internal');
    expect(classifyOutcome('Rounded(ByteLimit)')).toBe('internal');
    expect(classifyOutcome('batch_status=6')).toBe('batch');
    expect(classifyOutcome('path_status=1')).toBe('empty');
    expect(classifyOutcome('NO_MESH(flat_status=1)')).toBe('empty');
    expect(classifyOutcome('META')).toBe('other');
  });

  it('passes an unchanged branch and a failure that becomes ok', () => {
    expect(classifyFailureToSuccess(input(() => {})).counts).toEqual({
      identical: 2,
      allowedChange: 0,
      fail: 0,
      internalRegression: 0,
    });
    const allowed = classifyFailureToSuccess(
      input((n) => n.set('b', record('c', 'path_status=0'))),
    );
    expect(allowed.pass).toBe(true);
    expect(allowed.allowed).toEqual([
      { layer: 'native', case: 'b', baseCode: 'path_status=5', branchCode: 'path_status=0' },
    ]);
  });

  it('treats empty as a result: failure to empty is allowed, empty must stay equal', () => {
    const toEmpty = classifyFailureToSuccess(
      input((n) => n.set('b', record('c', 'path_status=1'))),
    );
    expect(toEmpty.pass).toBe(true);
    expect(toEmpty.counts.allowedChange).toBe(1);
    const base = new Map([['e', record('e', 'path_status=1')]]);
    const changed = new Map([['e', record('f', 'path_status=6')]]);
    const wasm = { base: new Map(), branch: new Map() };
    const result = classifyFailureToSuccess({ native: { base, branch: changed }, wasm });
    expect(result.pass).toBe(false);
    expect(result.counts.allowedChange).toBe(0);
  });

  it('fails a base ok record that differs in any field of the tuple', () => {
    const changes: Array<(n: Map<string, DigestEntry>) => void> = [
      (n) => n.set('a', record('c', 'path_status=0')),
      (n) => n.set('a', record('a', 'path_status=0', 1)),
      (n) => n.set('a', record('a', 'path_status=0', 0, 1)),
      (n) => n.set('a', record('a', 'path_status=6')),
      (n) => n.delete('a'),
    ];
    for (const change of changes) {
      const result = classifyFailureToSuccess(input(change));
      expect(result.pass).toBe(false);
      expect(result.fails.map((item: { case: string }) => item.case)).toEqual(['a']);
    }
  });

  it('counts a path failure that becomes an internal or batch failure as an internal-regression', () => {
    for (const code of ['Rounded(InternalInvariant)', 'batch_status=6', 'Unknown(1)']) {
      const result = classifyFailureToSuccess(input((n) => n.set('b', record('c', code))));
      expect(result.pass).toBe(false);
      expect(result.counts.internalRegression).toBe(1);
      expect(result.counts.fail).toBe(1);
      expect(result.counts.allowedChange).toBe(0);
    }
  });

  it('detects a tampered ok record in each layer', () => {
    const wasm = {
      base: new Map([['w', record('d', 'path_status=0')]]),
      branch: new Map([['w', record('d', 'path_status=0')]]),
    };
    const checks = failureToSuccessTamperChecks({ ...input(() => {}), wasm });
    expect(checks).toEqual([
      { case: 'a', detected: true },
      { case: 'w', detected: true },
    ]);
  });
});
