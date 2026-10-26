import { describe, expect, it } from 'vitest';
import { controlPorts, fan, meshFromTriangles } from './e3-a04/controls.js';
import {
  mapPoint,
  measureCase,
  noFlip,
  withPositiveArea,
  withoutCollapsed,
  type HarnessRow,
  type Mapped,
  type ShaderLanes,
} from './e3-a04/harness.js';
import {
  DECLARED_PAIRS,
  DECLARED_TRANSFORMS,
  buildRecord,
  knownClassOf,
  validateRecord,
} from './e3-a04/record.js';
import { harnessCase } from './e3-a04/smoke.js';
import { fill, polygon, rect } from './e3-a04/oracle-cases.js';

// D9 E3 section 21 (docs/plans/d9-e3-b4-precision-contract.md): the known classes A04
// discloses instead of counting, the `PASS with disclosure` verdict, and the off-window
// zero-area triangles that M* leaves out (section 21.4).

const ports = controlPorts({ status: 'ok', mesh: meshFromTriangles(fan(rect(0, 0, 64, 32))) });
const base = measureCase(
  harnessCase({ id: 'base', ...polygon(rect(0, 0, 64, 32)), paint: fill() }),
  ports,
);

function row(over: Partial<HarnessRow>): HarnessRow {
  return { ...base, ...over };
}

/** One PASS row per declared cell and paint, so that coverage holds. */
function fullCoverage(): HarnessRow[] {
  const rows: HarnessRow[] = [];
  for (const paint of ['fill', 'stroke'] as const)
    for (const transform of DECLARED_TRANSFORMS)
      for (const pair of DECLARED_PAIRS)
        rows.push(
          row({ id: `${paint}/${transform}/${pair}`, paint, transform, pair, status: 'pass' }),
        );
  return rows.map((r, index) => ({ ...r, index }));
}

const passing = {
  provenance: { commit: 'test', dirty: false, corpusSha256: 'test', oracleCertified: true },
  gpu: { passed: true, browsers: [], record: 'test' },
  controls: [{ id: 'PC1', expected: 'x', observed: 'x', ok: true }],
};

describe('E3 section 21 known classes', () => {
  it('classifies rows mechanically', () => {
    const c4 = { stratum: 'C4', gapTarget: 2 ** -16, id: 'C4/n23/T2/z64-d3/center/k0' };
    expect(knownClassOf(row({ ...c4, status: 'fail' }))).toBe('collapsed-feature');
    expect(knownClassOf(row({ ...c4, status: 'undecided', reason: 'x' }))).toBe(
      'collapsed-feature',
    );
    expect(knownClassOf(row({ ...c4, status: 'pass' }))).toBeNull();
    // The overlapping rectangles have no gap: their FAIL is a real FAIL.
    expect(
      knownClassOf(row({ ...c4, id: 'C4/n17/T2/z64-d3/center/k0', status: 'fail' })),
    ).toBeNull();
    // g = 2^-8 is not below 2^-8, and g = 0 has no target.
    expect(knownClassOf(row({ stratum: 'C4', gapTarget: 2 ** -8, status: 'fail' }))).toBeNull();
    expect(knownClassOf(row({ stratum: 'C4', gapTarget: null, status: 'fail' }))).toBeNull();
    expect(knownClassOf(row({ stratum: 'C3', gapTarget: 2 ** -16, status: 'fail' }))).toBeNull();

    expect(knownClassOf(row({ status: 'undecided', reason: 'beta ≥ 1 px' }))).toBe('far-vertices');
    expect(knownClassOf(row({ status: 'undecided', reason: 'clip bound ≥ 0.25 px' }))).toBe(
      'far-vertices',
    );
    // A real FAIL is never disclosed as far vertices.
    expect(knownClassOf(row({ status: 'fail', reason: 'beta ≥ 1 px' }))).toBeNull();

    const zeroArea = {
      status: 'undecided' as const,
      reason: 'no-flip certificate',
      flipTolerant: {
        rho: null,
        reason: 'zero-area triangle off M*',
        edges: 0,
        pieces: 0,
        work: 1,
      },
    };
    expect(knownClassOf(row({ ...zeroArea, paint: 'stroke' }))).toBe('degenerate-stroke-triangle');
    expect(knownClassOf(row({ ...zeroArea, paint: 'fill' }))).toBeNull();
    expect(
      knownClassOf(row({ paint: 'stroke', status: 'undecided', reason: 'no-flip certificate' })),
    ).toBeNull();
  });

  it('gives PASS with disclosure only when everything else passes', () => {
    const rows = fullCoverage();
    const clean = { ...passing, selection: { stride: 1, shards: 1, corpusCases: rows.length } };
    const plain = buildRecord({ ...clean, rows });
    expect(plain.verdict).toBe('PASS');

    const extra = [
      row({
        id: 'C4/n07/T5/z64-d3/center/k0',
        stratum: 'C4',
        gapTarget: 2 ** -16,
        status: 'fail',
        u: 1,
        l: 1,
      }),
      row({ id: 'far', status: 'undecided', reason: 'beta ≥ 1 px' }),
    ];
    const withKnown = [...rows, ...extra].map((r, index) => ({ ...r, index }));
    const sel = { stride: 1, shards: 1, corpusCases: withKnown.length };
    const record = buildRecord({ ...passing, selection: sel, rows: withKnown });
    expect(record.verdict).toBe('PASS with disclosure');
    expect(record.disclosed).toEqual({
      'collapsed-feature': ['C4/n07/T5/z64-d3/center/k0'],
      'far-vertices': ['far'],
      'degenerate-stroke-triangle': [],
    });
    const ids = withKnown.map((r) => r.id);
    expect(validateRecord(record, ids)).toEqual([]);
    expect(
      validateRecord({ ...record, disclosed: { ...record.disclosed, 'far-vertices': [] } }, ids),
    ).toContain('disclosed cases differ from the rows');

    // A FAIL outside the classes still fails A04, and an UNDECIDED one keeps it UNVERIFIED.
    const fail = [
      ...withKnown,
      { ...row({ id: 'f', status: 'fail', u: 1, l: 1 }), index: withKnown.length },
    ];
    expect(
      buildRecord({ ...passing, selection: { ...sel, corpusCases: fail.length }, rows: fail })
        .verdict,
    ).toBe('FAIL');
    const open = [
      ...withKnown,
      {
        ...row({ id: 'u', status: 'undecided', reason: 'no-flip certificate' }),
        index: withKnown.length,
      },
    ];
    const u = buildRecord({
      ...passing,
      selection: { ...sel, corpusCases: open.length },
      rows: open,
    });
    expect(u.verdict).toBe('UNVERIFIED');
    expect(u.verdictReasons).toContain('1 UNDECIDED case(s)');
  });

  it('a cell measured only by disclosed cases stays uncovered', () => {
    const rows = fullCoverage().map((r) =>
      r.id === 'fill/T0/z1-d1' ? { ...r, status: 'undecided' as const, reason: 'beta ≥ 1 px' } : r,
    );
    const record = buildRecord({
      ...passing,
      selection: { stride: 1, shards: 1, corpusCases: rows.length },
      rows,
    });
    expect(record.uncoveredCells).toEqual(['fill/T0/z1-d1']);
    expect(record.verdict).toBe('UNVERIFIED');
  });
});

describe('E3 section 21.4 off-window zero-area triangles', () => {
  const lanes: ShaderLanes = {
    linear: [1, 0, 0, 1],
    anchor: [0, 0],
    frame: { originMinusCamera: [0, 0], zoom: 1, dpr: 1, width: 640, height: 360 },
  };
  it('leaves a zero-area triangle off the certificate region out of M*', () => {
    // A square in Ω, and three collinear, distinct points off Ω ⊕ 4 (x ≥ 700).
    const pts = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [700, 10],
      [710, 10],
      [730, 10],
    ] as const;
    const m: Mapped = {
      points: pts.map(([x, y]) => mapPoint(x, y, lanes)),
      indices: [0, 1, 2, 0, 2, 3, 4, 5, 6],
      width: 640,
      height: 360,
    };
    // The certificate holds: it checks only triangles near Ω.
    expect(noFlip(m, 1e-3)).toMatchObject({ checked: 2, failed: 0 });
    // withoutCollapsed keeps the zero-area triangle, which the oracle rejects as an invalid
    // mesh; M* (withPositiveArea) leaves it out and keeps the square.
    expect(withoutCollapsed(m)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6]);
    expect(withPositiveArea(m)).toEqual([0, 1, 2, 0, 2, 3]);
  });
});
