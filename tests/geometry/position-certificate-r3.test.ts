import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedProjectionFixtures } from './mesh-projection/fixtures.js';
import {
  certifyPosition,
  certifyWindow,
  originP1,
  originPX,
} from './position-certificate/certificate.js';
import { originSequences, prospectiveRows, termRows } from './position-certificate/corpus.js';
import {
  clearanceAtDelta,
  originPXTarget,
  R3_TARGETS,
  rebaseCounts,
  trajectories,
} from './position-certificate/r3-window.js';
import { add, compare, mul, rational, toNumber, type Rational } from './rounded-fill/exact.js';

// P3.1m R3: docs/plans/p3-r3-origin-window-contract.md.
const ARCHIVED_REPORT = 'docs/evidence/p3.1m-position-certificate/report.json';
const PINNED = {
  'tests/geometry/position-certificate/certificate.ts':
    'dea97bcda4c9fc1380a0f5895ef5eeee9ffffdfd2de7c8415ea05c16e8cc3767',
  [ARCHIVED_REPORT]: '8bc1eb2d7cb38be6afee114a69817ac22f0d138f9a641024e39489d77b902351',
} as const;
const SOURCES = [
  'tests/geometry/position-certificate/r3-window.ts',
  'tests/geometry/position-certificate-r3.test.ts',
  'tests/geometry/position-certificate/certificate.ts',
  'tests/geometry/position-certificate/corpus.ts',
  'tests/geometry/rounded-fill/exact.ts',
] as const;
const REPORT = 'docs/evidence/p3.1m-r3-origin-window/report.json';
const TIMEOUT = 60_000;

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const exact = (value: Rational | null) =>
  value === null
    ? null
    : { n: value.n.toString(), d: value.d.toString(), approx: toNumber(value).toExponential(5) };

type ArchivedRow = Readonly<{
  id: string;
  policy: string;
  origin: [number, number];
  g: number | null;
  status: string;
  reason: string | null;
  delta2Max: { n: string; d: string };
  window: { halfWidth: number; admitted: boolean } | null;
}>;

const archived = JSON.parse(readFileSync(ARCHIVED_REPORT, 'utf8')) as {
  admittedRows: string[];
  rows: ArchivedRow[];
};
const fixtures = fixedProjectionFixtures();
const adm = new Set(
  archived.admittedRows.filter((key) => key.endsWith('|fixture')).map((key) => key.slice(0, -8)),
);

function windowDelta2(ewx: readonly (Rational | null)[], ewy: readonly (Rational | null)[]) {
  let max = rational(0n);
  ewx.forEach((x, vertex) => {
    const y = ewy[vertex];
    if (x === null || y === null || y === undefined) return;
    const value = add(mul(x, x), mul(y, y));
    if (compare(value, max) > 0) max = value;
  });
  return max;
}

type Slack = { slack: Rational; term: string; id: string } | null;
const minSlack = (
  current: Slack,
  slack: Rational | null,
  term: string | null,
  id: string,
): Slack =>
  slack === null || term === null || (current !== null && compare(slack, current.slack) >= 0)
    ? current
    : { slack, term, id };

describe('P3.1m R3 mesh-origin window selection', () => {
  it('pins the unchanged certificate and archived report', () => {
    for (const [file, hash] of Object.entries(PINNED))
      expect(sha256(readFileSync(path.resolve(file))), file).toBe(hash);
    expect(adm.size).toBe(127);
    expect(adm.has('rectangle/4096x4096/R45/stress')).toBe(false);
    expect(adm.has('rectangle/4096x4096/scale/stress')).toBe(false);
  });

  it(
    'reproduces certifyPosition clearance with pointwise delta on all fixture rows',
    () => {
      let evaluated = 0;
      for (const fixture of fixtures) {
        const certificate = certifyPosition(fixture.input, fixture.input.origin);
        if (certificate.reason === 'lane-range' || certificate.reason === 'singular') continue;
        evaluated += 1;
        expect(clearanceAtDelta(fixture.input, certificate.delta2Max).term, fixture.id).toBe(
          certificate.clearance.term,
        );
      }
      expect(evaluated).toBe(158);
    },
    TIMEOUT,
  );

  const results = new Map<
    number,
    {
      s1Failures: string[];
      s2Failures: string[];
      pointSlack: Slack;
      windowSlack: Slack;
    }
  >();

  it(
    'reproduces the archived O-PX records at T = 1024',
    () => {
      for (const fixture of fixtures) {
        const { camera, zoom, dpr } = fixture.input;
        const derived = originPXTarget(camera, zoom, dpr, 1024);
        expect(derived).toEqual(originPX(camera, zoom, dpr));
        const record = archived.rows.find((row) => row.id === fixture.id && row.policy === 'O-PX')!;
        const certificate = certifyPosition(fixture.input, derived.origin);
        const window = certifyWindow(fixture.input, derived.origin, 2 * derived.g);
        expect(derived.origin, fixture.id).toEqual(record.origin);
        expect(derived.g).toBe(record.g);
        expect(certificate.status).toBe(record.status);
        expect(certificate.reason).toBe(record.reason);
        expect({
          n: certificate.delta2Max.n.toString(),
          d: certificate.delta2Max.d.toString(),
        }).toEqual(record.delta2Max);
        expect(record.window?.halfWidth).toBe(2 * derived.g);
        expect(window.windowAdmitted).toBe(record.window?.admitted);
      }
    },
    TIMEOUT,
  );

  for (const target of R3_TARGETS)
    it(
      `evaluates S1 and S2 for T = ${target}`,
      () => {
        const s1Failures: string[] = [];
        const s2Failures: string[] = [];
        let pointSlack: Slack = null;
        let windowSlack: Slack = null;
        for (const fixture of fixtures) {
          if (!adm.has(fixture.id)) continue;
          const { camera, zoom, dpr } = fixture.input;
          const { origin, g } = originPXTarget(camera, zoom, dpr, target);
          const certificate = certifyPosition(fixture.input, origin);
          if (certificate.status !== 'ADMITTED')
            s1Failures.push(`${fixture.id}:${certificate.reason}`);
          const point = clearanceAtDelta(fixture.input, certificate.delta2Max);
          pointSlack = minSlack(pointSlack, point.slack, point.slackTerm, fixture.id);
          const window = certifyWindow(fixture.input, origin, 2 * g);
          const windowClearance = clearanceAtDelta(
            fixture.input,
            windowDelta2(window.ewx, window.ewy),
          );
          windowSlack = minSlack(
            windowSlack,
            windowClearance.slack,
            windowClearance.slackTerm,
            fixture.id,
          );
          if (!window.windowAdmitted) s2Failures.push(`${fixture.id}:window-position`);
          else if (windowClearance.term !== null)
            s2Failures.push(`${fixture.id}:window-clearance:${windowClearance.term}`);
        }
        results.set(target, { s1Failures, s2Failures, pointSlack, windowSlack });
      },
      TIMEOUT,
    );

  it(
    'selects the largest qualifying target, re-evaluates literal rows and counts rebases',
    () => {
      const qualifying = R3_TARGETS.filter((target) => {
        const result = results.get(target)!;
        return result.s1Failures.length === 0 && result.s2Failures.length === 0;
      });
      const selected = qualifying.length === 0 ? null : Math.max(...qualifying);

      const literal = [...prospectiveRows(), ...termRows()]
        .filter((row) => ['P1-CANCEL-64', 'PX-CANCEL-64', 'WIN-EDGE'].includes(row.id))
        .map((row) => {
          if (selected === null) return { id: row.id, selected: null };
          const { camera, zoom, dpr } = row.input;
          const { origin, g } = originPXTarget(camera, zoom, dpr, selected);
          const certificate = certifyPosition(row.input, origin);
          const window = certifyWindow(row.input, origin, 2 * g);
          return {
            id: row.id,
            origin,
            g,
            status: certificate.status,
            reason: certificate.reason,
            delta2Max: exact(certificate.delta2Max),
            windowAdmitted: window.windowAdmitted,
            windowClearance: clearanceAtDelta(row.input, windowDelta2(window.ewx, window.ewy)).term,
          };
        });

      expect(literal.map((row) => row.id)).toEqual(['P1-CANCEL-64', 'PX-CANCEL-64', 'WIN-EDGE']);

      const sequences = originSequences();
      const paths = trajectories(sequences);
      for (const trajectory of paths)
        for (const frame of trajectory.frames)
          expect(originPXTarget(frame.camera, frame.zoom, frame.dpr, 1024)).toEqual(
            originPX(frame.camera, frame.zoom, frame.dpr),
          );
      const rebases = paths.map((trajectory) => ({
        id: trajectory.id,
        frames: trajectory.frames.length,
        'O-P1': {
          originChanges: rebaseCounts(trajectory, (camera, _zoom, _dpr, previous) => ({
            origin: originP1(camera, previous?.origin),
            g: 0,
          })).originChanges,
          gChanges: 'n/a',
        },
        ...Object.fromEntries(
          R3_TARGETS.map((target) => [
            `O-PX(${target})`,
            rebaseCounts(trajectory, (camera, zoom, dpr, previous) =>
              originPXTarget(camera, zoom, dpr, target, previous),
            ),
          ]),
        ),
      }));

      const report = {
        schema: 'p3-r3-origin-window-report-v1',
        contract: 'docs/plans/p3-r3-origin-window-contract.md',
        sourceHashes: Object.fromEntries(
          [...SOURCES, ARCHIVED_REPORT].map((file) => [
            file,
            sha256(readFileSync(path.resolve(file))),
          ]),
        ),
        admCount: adm.size,
        candidates: R3_TARGETS.map((target) => {
          const result = results.get(target)!;
          return {
            target,
            s1Failures: result.s1Failures,
            s2Failures: result.s2Failures,
            qualifies: result.s1Failures.length === 0 && result.s2Failures.length === 0,
            minPointSlack:
              result.pointSlack === null
                ? null
                : {
                    ...exact(result.pointSlack.slack),
                    term: result.pointSlack.term,
                    id: result.pointSlack.id,
                  },
            minWindowSlack:
              result.windowSlack === null
                ? null
                : {
                    ...exact(result.windowSlack.slack),
                    term: result.windowSlack.term,
                    id: result.windowSlack.id,
                  },
          };
        }),
        selected,
        literal,
        rebases,
      };
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (process.env.P3_R3_WRITE === '1') {
        mkdirSync(path.dirname(REPORT), { recursive: true });
        writeFileSync(REPORT, text);
      }
      expect(existsSync(REPORT), 'run with P3_R3_WRITE=1 to create the report').toBe(true);
      expect(readFileSync(REPORT, 'utf8')).toBe(text);
    },
    TIMEOUT,
  );
});
