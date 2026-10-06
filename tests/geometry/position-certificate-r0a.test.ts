import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedProjectionFixtures } from './mesh-projection/fixtures.js';
import type { ProjectionInput } from './mesh-projection/model.js';
import { certifyPosition, certifyWindow, sqrtUp } from './position-certificate/certificate.js';
import { prospectiveRows, termRows } from './position-certificate/corpus.js';
import { clearanceAtDelta, originPXTarget } from './position-certificate/r3-window.js';
import {
  certifyC2,
  certifyC2Window,
  exteriorWedges,
  sqrtDown,
  wedgeTerm,
} from './position-certificate/wedge.js';
import {
  independentExteriorWedges,
  independentSqrtDown,
  independentWedgeTerm,
} from './position-certificate/wedge-independent.js';
import { add, compare, mul, rational, toNumber, type Rational } from './rounded-fill/exact.js';

// P3.1n R0a: docs/plans/p3-r0a-wedge-clearance-contract.md.
const PINNED = {
  'tests/geometry/position-certificate/certificate.ts':
    'dea97bcda4c9fc1380a0f5895ef5eeee9ffffdfd2de7c8415ea05c16e8cc3767',
  'tests/geometry/position-certificate/r3-window.ts':
    '463a4af1db59a1cbd6d73aeee436690c99d73218caa30b88467fdbc9d664a894',
  'docs/evidence/p3.1m-position-certificate/report.json':
    '8bc1eb2d7cb38be6afee114a69817ac22f0d138f9a641024e39489d77b902351',
  'docs/evidence/p3.1m-r3-origin-window/report.json':
    '86089572da86480619b67e90b5be801a1cd29556029d187f0b33a636dd73f0a1',
} as const;
const SOURCES = [
  'tests/geometry/position-certificate/wedge.ts',
  'tests/geometry/position-certificate/wedge-independent.ts',
  'tests/geometry/position-certificate-r0a.test.ts',
] as const;
const REPORT = 'docs/evidence/p3.1n-r0a-wedge/report.json';
const TARGET = 128;
const TIMEOUT = 60_000;

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const exact = (value: Rational) => ({
  n: value.n.toString(),
  d: value.d.toString(),
  approx: toNumber(value).toExponential(5),
});
const wedgeKey = (w: { vertex: number; a: number; b: number }) => `${w.vertex}:${w.a}:${w.b}`;
const unordered = (w: { vertex: number; a: number; b: number }) =>
  `${w.vertex}:${Math.min(w.a, w.b)}:${Math.max(w.a, w.b)}`;

function mesh(vertices: [number, number][], indices: number[]): ProjectionInput['mesh'] {
  return { vertices, indices };
}

function row(m: ProjectionInput['mesh']): ProjectionInput {
  return {
    id: 'control',
    mesh: m,
    affine: [1, 0, 0, 1, 0, 0],
    camera: [0, 0],
    origin: [0, 0],
    zoom: 1,
    dpr: 1,
    width: 640,
    height: 360,
  };
}

function windowDelta2(
  input: ProjectionInput,
  origin: readonly [number, number],
  halfWidth: number,
) {
  const window = certifyWindow(input, origin, halfWidth);
  let max = rational(0n);
  window.ewx.forEach((x, vertex) => {
    const y = window.ewy[vertex];
    if (x === null || y === null || y === undefined) return;
    const value = add(mul(x, x), mul(y, y));
    if (compare(value, max) > 0) max = value;
  });
  return { window, delta2: max };
}

function crossCheck(input: ProjectionInput, delta2: Rational, label: string) {
  const mine = wedgeTerm(input, delta2);
  const theirs = independentWedgeTerm(input, delta2);
  expect(theirs.term, label).toBe(mine.term);
  const theirMin = theirs.wedges.reduce<Rational | null>(
    (best, wedge) => (best === null || compare(wedge.slack, best) < 0 ? wedge.slack : best),
    null,
  );
  if (mine.worst === null) expect(theirMin, label).toBeNull();
  else expect(compare(theirMin!, mine.worst.slack), label).toBe(0);
}

describe('P3.1n R0a C2 exterior-wedge clearance', () => {
  it('pins unchanged certificate, R3 module and archived reports', () => {
    for (const [file, hash] of Object.entries(PINNED))
      expect(sha256(readFileSync(path.resolve(file))), file).toBe(hash);
  });

  it('identifies exterior wedges and throws on invalid input (controls)', () => {
    const straight = mesh(
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
        [0, 1],
      ],
      [0, 1, 4, 1, 2, 3, 1, 3, 4],
    );
    const atStraight = exteriorWedges(straight).filter((w) => w.vertex === 1);
    expect(atStraight).toHaveLength(1);
    const tiny = rational(1n, 1n << 40n);
    expect(wedgeTerm(row(straight), tiny).term).toBeNull();

    const fan = mesh(
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [1, 1],
      ],
      [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
    );
    expect(exteriorWedges(fan).filter((w) => w.vertex === 4)).toHaveLength(0);

    const epsilon = 2 ** -20;
    const pinch = mesh(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [1, 1 + epsilon],
        [0, 1],
      ],
      [0, 1, 2, 0, 3, 4],
    );
    expect(exteriorWedges(pinch).filter((w) => w.vertex === 0)).toHaveLength(2);
    const pinchPass = wedgeTerm(row(pinch), rational(1n, 1n << 80n));
    expect(pinchPass.term).toBeNull();
    expect(pinchPass.worst?.margin).toBe('cross');
    const reflected = { ...row(pinch), affine: [-1, 0, 0, 1, 0, 0] as const };
    const reflectedPass = wedgeTerm(reflected, rational(1n, 1n << 80n));
    expect(reflectedPass.term).toBeNull();
    expect(compare(reflectedPass.worst!.slack, pinchPass.worst!.slack)).toBe(0);
    expect(wedgeTerm(row(pinch), rational(1n, 1n << 30n)).term).toBe('wedge');

    const mirrored = mesh(
      straight.vertices.map(([x, y]) => [-x, y]),
      [...straight.indices],
    );
    expect(new Set(exteriorWedges(mirrored).map(unordered))).toEqual(
      new Set(exteriorWedges(straight).map(unordered)),
    );

    expect(() =>
      exteriorWedges(
        mesh(
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ],
          [0, 1, 2, 1, 2, 3],
        ),
      ),
    ).toThrow('input:wedge-orientation');
    expect(() =>
      exteriorWedges(
        mesh(
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 2],
          ],
          [0, 1, 2, 0, 1, 3],
        ),
      ),
    ).toThrow('input:wedge-nonmanifold');
    expect(() =>
      exteriorWedges(
        mesh(
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 0],
            [2, -1],
          ],
          [0, 1, 2, 0, 4, 3],
        ),
      ),
    ).toThrow('input:wedge-degenerate');

    for (const control of [straight, fan, pinch, mirrored])
      expect(new Set(independentExteriorWedges(control).map(unordered))).toEqual(
        new Set(exteriorWedges(control).map(unordered)),
      );
  });

  it('bounds square roots in both directions', () => {
    for (const value of [
      rational(2n),
      rational(1n, 3n),
      rational(10n ** 40n + 7n, 3n),
      rational((1n << 2000n) + 1n, 7n),
      rational(1n, 1n << 200n),
    ]) {
      const lower = sqrtDown(value);
      expect(independentSqrtDown(value)).toEqual(lower);
      expect(compare(mul(lower, lower), value)).toBeLessThanOrEqual(0);
      const next = add(lower, rational(1n, 1n << 64n));
      expect(compare(mul(next, next), value)).toBeGreaterThan(0);
      const upper = sqrtUp(value);
      expect(compare(mul(upper, upper), value)).toBeGreaterThanOrEqual(0);
    }
  });

  const records: Record<string, unknown>[] = [];
  const fixtures = fixedProjectionFixtures();

  it(
    'evaluates C2 at the fixture origin with monotonicity and independent cross-checks',
    () => {
      for (const fixture of fixtures) {
        const p31m = certifyPosition(fixture.input, fixture.input.origin);
        let c2: ReturnType<typeof certifyC2> | undefined;
        expect(
          () => (c2 = certifyC2(fixture.input, fixture.input.origin)),
          fixture.id,
        ).not.toThrow();
        if (p31m.status === 'ADMITTED') expect(c2!.status, fixture.id).toBe('ADMITTED');
        if (p31m.reason !== 'lane-range' && p31m.reason !== 'singular') {
          crossCheck(fixture.input, p31m.delta2Max, fixture.id);
          expect(new Set(independentExteriorWedges(fixture.input.mesh).map(wedgeKey))).toEqual(
            new Set(exteriorWedges(fixture.input.mesh).map(wedgeKey)),
          );
        }
        records.push({
          id: fixture.id,
          policy: 'fixture',
          status: c2!.status,
          reason: c2!.reason,
          term: c2!.clearance.term,
          p31m: p31m.reason,
          wedge: c2!.wedge === null ? null : { ...c2!.wedge, slack: exact(c2!.wedge.slack) },
        });
      }
    },
    TIMEOUT,
  );

  it(
    'evaluates C2 under O-PX(128) pointwise and window',
    () => {
      for (const fixture of fixtures) {
        const { camera, zoom, dpr } = fixture.input;
        const { origin, g } = originPXTarget(camera, zoom, dpr, TARGET);
        const p31m = certifyPosition(fixture.input, origin);
        const c2 = certifyC2(fixture.input, origin);
        if (p31m.status === 'ADMITTED') expect(c2.status, fixture.id).toBe('ADMITTED');
        if (p31m.reason !== 'lane-range' && p31m.reason !== 'singular')
          crossCheck(fixture.input, p31m.delta2Max, `${fixture.id}/px`);
        records.push({
          id: fixture.id,
          policy: 'O-PX(128)',
          status: c2.status,
          reason: c2.reason,
          term: c2.clearance.term,
          p31m: p31m.reason,
          wedge: c2.wedge === null ? null : { ...c2.wedge, slack: exact(c2.wedge.slack) },
        });
        const { window, delta2 } = windowDelta2(fixture.input, origin, 2 * g);
        const r3Window =
          window.windowAdmitted && clearanceAtDelta(fixture.input, delta2).term === null;
        const c2Window = certifyC2Window(fixture.input, origin, 2 * g);
        if (r3Window) expect(c2Window.windowAdmitted, `${fixture.id}/window`).toBe(true);
        if (window.reason !== 'lane-range' && window.reason !== 'singular')
          crossCheck(fixture.input, delta2, `${fixture.id}/window`);
        records.push({
          id: fixture.id,
          policy: 'O-PX(128) window',
          status: c2Window.windowAdmitted ? 'ADMITTED' : 'NOT_ADMITTED',
          reason: c2Window.windowAdmitted
            ? null
            : c2Window.clearance.term === null
              ? 'window-position'
              : `clearance:${c2Window.clearance.term}`,
          term: c2Window.clearance.term,
          p31m: r3Window ? null : 'not-admitted',
          wedge:
            c2Window.wedge === null
              ? null
              : { ...c2Window.wedge, slack: exact(c2Window.wedge.slack) },
        });
      }
    },
    TIMEOUT,
  );

  it(
    'evaluates literal rows and writes the deterministic report',
    () => {
      for (const literal of [...prospectiveRows(), ...termRows()]) {
        let c2: ReturnType<typeof certifyC2> | undefined;
        expect(() => (c2 = certifyC2(literal.input, literal.origin)), literal.id).not.toThrow();
        const p31m = certifyPosition(literal.input, literal.origin);
        if (p31m.status === 'ADMITTED') expect(c2!.status, literal.id).toBe('ADMITTED');
        records.push({
          id: literal.id,
          policy: 'literal',
          status: c2!.status,
          reason: c2!.reason,
          term: c2!.clearance.term,
          p31m: p31m.reason,
          wedge: c2!.wedge === null ? null : { ...c2!.wedge, slack: exact(c2!.wedge.slack) },
        });
      }
      const counts: Record<string, number> = {};
      for (const record of records) {
        const key = `${record.policy as string}:${(record.reason as string | null) ?? 'ADMITTED'}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      const report = {
        schema: 'p3-r0a-wedge-report-v1',
        contract: 'docs/plans/p3-r0a-wedge-clearance-contract.md',
        sourceHashes: Object.fromEntries(
          [...SOURCES, ...Object.keys(PINNED)].map((file) => [
            file,
            sha256(readFileSync(path.resolve(file))),
          ]),
        ),
        counts,
        newlyAdmitted: records
          .filter((record) => record.status === 'ADMITTED' && record.p31m !== null)
          .map((record) => `${record.id as string}|${record.policy as string}`),
        admitted: records
          .filter((record) => record.status === 'ADMITTED')
          .map((record) => `${record.id as string}|${record.policy as string}`),
        rows: records,
      };
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (process.env.P3_R0A_WRITE === '1') {
        mkdirSync(path.dirname(REPORT), { recursive: true });
        writeFileSync(REPORT, text);
      }
      expect(existsSync(REPORT), 'run with P3_R0A_WRITE=1 to create the report').toBe(true);
      expect(readFileSync(REPORT, 'utf8')).toBe(text);
    },
    TIMEOUT,
  );
});
