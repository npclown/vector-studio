/**
 * P3 B0 spike, unit SL-U2 (`docs/plans/p3-b0-spike-ladder-contract.md` sections 4.1-4.5, 4.8
 * and 7.2, SL-A5 and SL-A6): runs the ignored Rust test `emit_spike_fixtures` with the pinned
 * toolchain, as the P3.2g native-topology bridge does, then applies the independent oracles
 * SL-O1, SL-O2, the SL-O3 area band and SL-O5 to every fixture output, checks every positive
 * control is rejected and checks that the oracles detect the seeded defects.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CONDITIONS,
  exactHex,
  judgeRung,
  parseSpikeFixtures,
  sliverStatistics,
  snapViewFinalKnots,
  verifyAgreement,
  verifyCertificate,
  verifyRegionMesh,
  type CertificateResult,
  type Condition,
  type RegionItem,
  type HexPoint,
  type SpikeEntry,
  type SpikeFixtures,
  type SpikeMesh,
} from './p3-b0-spike/oracle.js';
import { bitsOf, compare, fromBits, mul, rational, type Rational } from './rounded-fill/exact.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
/** τ = `TOPOLOGY_TOLERANCE` = 0.0625 (section 1). */
const TAU = rational(1n, 16n);

function captureFixtures(): SpikeFixtures {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const result = spawnSync(
    rustup,
    [
      'run',
      '1.94.1',
      'cargo',
      'test',
      '--release',
      '--manifest-path',
      manifest,
      '--locked',
      '--offline',
      '--lib',
      'p3_b0_spike_tests::emit_spike_fixtures',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  raw = result.stdout;
  return parseSpikeFixtures(result.stdout);
}

let raw: string;
let data: SpikeFixtures;
let delta: Rational;

beforeAll(() => {
  data = captureFixtures();
  delta = exactHex(data.delta);
}, 600_000);

function entry(id: string): SpikeEntry {
  const found = data.fixtures.find((fixture) => fixture.id === id);
  if (found === undefined) throw new Error(`unknown fixture ${id}`);
  return found;
}

function fastEntries(): readonly SpikeEntry[] {
  return data.fixtures.filter(({ rung }) => rung === 'fast');
}

function nextBits(bits: string): string {
  return (BigInt(`0x${bits}`) + 1n).toString(16).padStart(16, '0');
}

function format(value: Rational): string {
  return (Number(value.n) / Number(value.d)).toPrecision(6);
}

/**
 * The outcome against the fixture's literal expectation, checked with the exact oracles: rung
 * and reason, the exact signed area, the boundary contours SL-O2 derives and the triangle count.
 */
function literalMismatch(fixture: SpikeEntry, expectation: SpikeEntry['expected']): string | null {
  if (expectation.kind === 'fallback')
    return fixture.rung === 'fallback' && fixture.reason === expectation.reason
      ? null
      : `expected ${expectation.reason}, got ${fixture.rung} ${fixture.reason}`;
  if (expectation.kind === 'passes')
    return fixture.rung === 'none' && fixture.stop === expectation.stage
      ? null
      : `expected ${expectation.stage} to pass, got ${fixture.rung} ${fixture.reason}`;
  if (fixture.rung !== 'fast' || fixture.mesh === null)
    return `expected fast, got ${fixture.rung} ${fixture.reason}`;
  const region = verifyRegionMesh(fixture, fixture.rule, fixture.mesh);
  if (expectation.area !== null && compare(region.meshArea, exactHex(expectation.area)) !== 0)
    return `area ${format(region.meshArea)}, expected ${format(exactHex(expectation.area))}`;
  if (
    expectation.boundary !== null &&
    JSON.stringify(region.boundary) !== JSON.stringify(expectation.boundary)
  )
    return `boundary ${JSON.stringify(region.boundary)}, expected ${JSON.stringify(expectation.boundary)}`;
  if (expectation.triangles !== null && fixture.mesh.triangles.length !== expectation.triangles)
    return `${fixture.mesh.triangles.length} triangles, expected ${expectation.triangles}`;
  return null;
}

/** All oracle rejections of one outcome: SL-O1 soundness and, for a fast mesh, SL-O2. */
function oracleRejections(fixture: SpikeEntry, certificate: CertificateResult): readonly string[] {
  const rejections: string[] = [];
  const judgement = judgeRung(fixture, certificate);
  for (const condition of judgement.unsound)
    rejections.push(
      `SL-O1: ${condition} passed by the rung fails exactly (${certificate.details[condition] ?? 'unevaluated'})`,
    );
  if (fixture.rung === 'fast' && fixture.mesh !== null) {
    const region = verifyRegionMesh(fixture, fixture.rule, fixture.mesh);
    for (const issue of region.issues) rejections.push(`SL-O2: ${issue}`);
    // SL-O6's curve share: the exact max |d_m|² is within the certified bound, below δ².
    if (fixture.maxDeviationSquared !== null && certificate.maxDeviationSquared !== null) {
      const certified = exactHex(fixture.maxDeviationSquared);
      if (compare(certificate.maxDeviationSquared, certified) > 0)
        rejections.push('SL-O1: exact max |d_m|² exceeds the certified bound');
      if (compare(certified, mul(delta, delta)) >= 0)
        rejections.push('SL-O1: the certified bound is not below δ²');
    }
  }
  return rejections;
}

/**
 * The SL-O2 checks each mesh control must trip (review item S2): a flipped triangle item 1 and
 * the P3.1b inspector, a missing triangle items 3 and 4, a duplicated triangle item 3 and the
 * inspector (overlap), a moved vertex item 2.
 */
const EXPECTED_ITEMS: Readonly<Record<string, readonly RegionItem[]>> = {
  flipped: ['item1', 'inspect'],
  missing: ['item3', 'item4'],
  duplicated: ['item3', 'inspect'],
  movedVertex: ['item2'],
};

type DefectCause = Readonly<{
  unsound?: Condition;
  items?: readonly RegionItem[];
  conservative?: true;
}>;

/** Each seeded defect's expected cause: an unsound SL-O1 condition or failed SL-O2 checks. */
const DEFECT_CAUSES: Readonly<Record<string, DefectCause>> = {
  '(1) SL-F3': { unsound: 'SL-C3/clearance' },
  '(2) SL-F11': { unsound: 'SL-C1' },
  '(2) SL-F19': { unsound: 'SL-C1' },
  '(3) SL-F10': { unsound: 'SL-C2' },
  '(3) SL-F10b': { unsound: 'SL-C2' },
  '(4) SL-F1': { unsound: 'SL-C3/clearance' },
  '(4) SL-F3': { unsound: 'SL-C3/clearance' },
  '(4) SL-F18': { unsound: 'SL-C3/clearance' },
  '(5) SL-F12a': { conservative: true },
  '(6) SL-F6/nonzero': { items: ['item2', 'item3', 'inspect'] },
  '(7) SL-F5/nonzero': { items: ['item1', 'inspect'] },
  '(8) SL-F6/nonzero': { items: ['item2', 'item3', 'inspect'] },
  '(9) SL-F3': { unsound: 'SL-C3/clearance' },
  '(10) SL-F18': { unsound: 'SL-C3/clearance' },
};

function mutate(mesh: SpikeMesh, change: Partial<SpikeMesh>): SpikeMesh {
  return { ...mesh, ...change };
}

describe('P3 B0 spike SL-U2 independent oracles', () => {
  it('parses the p3-b0-spike-fixtures/1 hand-off strictly', () => {
    expect(data.schema).toBe('p3-b0-spike-fixtures/1');
    expect(compare(delta, rational(1n, 8n))).toBe(0);
    expect(data.fixtures.filter(({ kind }) => kind === 'view')).toHaveLength(27);
    expect(data.fixtures.filter(({ kind }) => kind === 'ladder').map(({ id }) => id)).toEqual([
      'SL-F13/P4/s=4#0',
      'SL-F13/K2/s=3#0',
    ]);
    expect(new Set(data.fixtures.map(({ id }) => id)).size).toBe(data.fixtures.length);
    expect(data.defects).toHaveLength(14);
    expect(() => parseSpikeFixtures('no frame')).toThrow('exactly one frame');
  });

  it('SL-O1 and SL-O2 accept every fixture outcome at its literal expectation', () => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const fixture of data.fixtures) {
      const certificate = verifyCertificate(fixture, delta);
      const judgement = judgeRung(fixture, certificate);
      const mismatch = fixture.kind === 'view' ? literalMismatch(fixture, fixture.expected) : null;
      if (mismatch !== null) failures.push(`${fixture.id}: ${mismatch}`);
      for (const rejection of oracleRejections(fixture, certificate))
        failures.push(`${fixture.id}: ${rejection}`);
      // No named fallback is conservative (section 4.1), and each reason's condition fails
      // exactly.
      if (judgement.conservative === true)
        failures.push(`${fixture.id}: conservative fallback ${fixture.reason}`);
      if (fixture.rung === 'fallback' && judgement.reason !== 'exact')
        failures.push(`${fixture.id}: ${fixture.reason} is ${judgement.reason}`);
      const failing = CONDITIONS.filter((condition) => certificate.holds[condition] === false);
      rows.push(
        `${fixture.id}: ${fixture.rung}${fixture.reason ? ` ${fixture.reason}` : ''}; ` +
          `closures ${certificate.closures.join(',')}; exact failures [${failing.join(', ')}]; ` +
          `pairs ${certificate.pairs}${fixture.mesh ? `; T ${fixture.mesh.triangles.length}` : ''}`,
      );
    }
    console.log(`SL-O1/SL-O2 per fixture:\n${rows.join('\n')}`);
    expect(failures).toEqual([]);
  });

  it('SL-F13: both B0 paths are certified, valid and within the SL-O3 area band', () => {
    for (const id of ['SL-F13/P4/s=4#0', 'SL-F13/K2/s=3#0']) {
      const fixture = entry(id);
      expect(fixture.rung).toBe('fast');
      const certificate = verifyCertificate(fixture, delta);
      expect(CONDITIONS.every((condition) => certificate.holds[condition] === true)).toBe(true);
      expect(certificate.closures.every((closure) => closure === 'exact-close')).toBe(true);
      const region = verifyRegionMesh(fixture, fixture.rule, fixture.mesh!);
      expect(region.issues).toEqual([]);
      const agreement = verifyAgreement(fixture, fixture.rule, fixture.exact!, TAU);
      expect(agreement.samePolygon).toBe(true);
      expect(agreement.withinBand).toBe(true);
      const exactStats = sliverStatistics(fixture.exact!.mesh);
      const fastStats = sliverStatistics(fixture.mesh!);
      console.log(
        `${id}: fast V ${fixture.mesh!.vertices.length} T ${fixture.mesh!.triangles.length}; ` +
          `exact V ${fixture.exact!.mesh.vertices.length} T ${fixture.exact!.mesh.triangles.length}; ` +
          `SL-O1 pairs ${certificate.pairs}, exact max |d|² ${format(certificate.maxDeviationSquared!)} ` +
          `(certified ≤ ${format(exactHex(fixture.maxDeviationSquared!))}); ` +
          `|ΔA| ${format(agreement.difference)} ≤ band ${format(agreement.band)}; ` +
          `exact mesh SL-O2 item 3 ${agreement.exactMesh.chainMatches ? 'passes' : 'fails'} ` +
          `(issues: ${agreement.exactMesh.issues.length}); ` +
          `SL-O5 fast ${JSON.stringify({ ...fastStats, perTriangle: undefined })}; ` +
          `exact ${JSON.stringify({ ...exactStats, perTriangle: undefined })}`,
      );
      expect(fastStats.quality.min).toBeGreaterThan(0);
      expect(fastStats.quality.min).toBeLessThanOrEqual(1);
    }
  });

  it('SL-A6: SL-O2 rejects a flipped, missing or duplicated triangle and a moved vertex', () => {
    const accepted: string[] = [];
    let controls = 0;
    for (const fixture of fastEntries()) {
      const mesh = fixture.mesh!;
      const [first, ...rest] = mesh.triangles;
      const moved = mesh.vertices.map((vertex, index): HexPoint =>
        index === first![0] ? [nextBits(vertex[0]), vertex[1]] : vertex,
      );
      const variants: Record<string, SpikeMesh> = {
        flipped: mutate(mesh, { triangles: [[first![0], first![2], first![1]], ...rest] }),
        missing: mutate(mesh, { triangles: mesh.triangles.slice(0, -1) }),
        duplicated: mutate(mesh, { triangles: [...mesh.triangles, first!] }),
        movedVertex: mutate(mesh, { vertices: moved }),
      };
      for (const [name, variant] of Object.entries(variants)) {
        controls += 1;
        const region = verifyRegionMesh(fixture, fixture.rule, variant);
        const missing = EXPECTED_ITEMS[name]!.filter((item) => !region.failed.includes(item));
        if (region.ok || missing.length > 0)
          accepted.push(`${fixture.id} ${name}: missing [${missing.join(', ')}]`);
      }
      expect(verifyRegionMesh(fixture, fixture.rule, mesh).ok).toBe(true);
    }
    expect(controls).toBe(4 * fastEntries().length);
    expect(accepted).toEqual([]);
  });

  it('SL-A6: SL-O2 rejects a wrong boundary contour', () => {
    // SL-F6: under nonzero only the outer square bounds the region; under evenodd the inner
    // square is a hole. Each mesh is wrong for the other rule.
    const nonzero = entry('SL-F6/nonzero');
    const evenodd = entry('SL-F6/evenodd');
    // Under nonzero the inner square's vertices are not boundary vertices (item 2) and the
    // hole's edges are not in the oriented boundary (item 3).
    expect(verifyRegionMesh(nonzero, 'nonzero', evenodd.mesh!).failed).toEqual(
      expect.arrayContaining(['item2', 'item3']),
    );
    // Under evenodd the hole's vertices are unused (item 2) and its edges missing (item 3).
    expect(verifyRegionMesh(evenodd, 'evenodd', nonzero.mesh!).failed).toEqual(
      expect.arrayContaining(['item2', 'item3']),
    );
    // SL-F7's mesh (inner contour reversed, a hole) against SL-F6's polygon under nonzero.
    expect(verifyRegionMesh(nonzero, 'nonzero', entry('SL-F7/nonzero').mesh!).failed).toEqual(
      expect.arrayContaining(['item2', 'item3']),
    );
    // SL-F4's two squares, with the second square's triangles removed: a contour is lost.
    const two = entry('SL-F4');
    const firstSquare = two.mesh!.triangles.filter((triangle) =>
      triangle.every(
        (index) => compare(exactHex(two.mesh!.vertices[index]![0]), rational(1n)) <= 0,
      ),
    );
    expect(firstSquare.length).toBeGreaterThan(0);
    expect(
      verifyRegionMesh(two, 'nonzero', { ...two.mesh!, triangles: firstSquare }).failed,
    ).toEqual(expect.arrayContaining(['item2', 'item3', 'item4']));
    // P's simplicity premise: SL-F9's bowtie polygon with SL-F5's square mesh.
    expect(
      verifyRegionMesh(entry('SL-F9'), 'nonzero', entry('SL-F5/nonzero').mesh!).failed,
    ).toContain('simplicity');
    // SL-F2's crossing contours have nonzero areas, so only the crossing test can reject them.
    expect(
      verifyRegionMesh(entry('SL-F2'), 'nonzero', entry('SL-F5/nonzero').mesh!).issues,
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^P edges .* meet$/u)]));
  });

  it('SL-A6: SL-O1 rejects a moved vertex and a wrong owner, SL-O3 a wrong exact output', () => {
    // A vertex of SL-F5 moved by 3/16 > δ in x: SL-C1 fails exactly.
    const square = entry('SL-F5/nonzero');
    const movedPoints = square.points.map((vertex, index): HexPoint =>
      index === 1 ? ['4024600000000000', vertex[1]] : vertex,
    );
    expect(verifyCertificate({ ...square, points: movedPoints }, delta).holds['SL-C1']).toBe(false);
    // SL-F13: one cubic leaf's numerator changed, so the leaves no longer partition [0, 1].
    const path = entry('SL-F13/P4/s=4#0');
    const owners = path.owners.map((owner, index) =>
      index === 1 && owner.kind === 'cubicLeaf' ? { ...owner, endNumerator: 3 } : owner,
    );
    expect(verifyCertificate({ ...path, owners }, delta).holds['SL-C0']).toBe(false);
    // SL-F13: a leaf assigned depth + 1 with the same numerator covers a different interval.
    const deeper = path.owners.map((owner, index) =>
      index === 0 && owner.kind === 'cubicLeaf' ? { ...owner, depth: owner.depth + 1 } : owner,
    );
    expect(verifyCertificate({ ...path, owners: deeper }, delta).holds['SL-C0']).toBe(false);
    // SL-F17: its CLOSE verb renumbered before the contour's last source (review item N4).
    const closed = entry('SL-F17');
    expect(verifyCertificate(closed, delta).holds['SL-C0']).toBe(true);
    const early = closed.owners.map((owner) =>
      owner.kind === 'explicitClose' ? { ...owner, sourceVerb: 1 } : owner,
    );
    expect(verifyCertificate({ ...closed, owners: early }, delta).details['SL-C0']).toContain(
      'CLOSE verb out of order',
    );
    // SL-O3: the exact mesh scaled by 2 leaves the area band; a changed point breaks identity.
    const exact = path.exact!;
    const double = (bits: string): string =>
      bitsOf(2 * fromBits(BigInt(`0x${bits}`)))
        .toString(16)
        .padStart(16, '0');
    const scaled = exact.mesh.vertices.map(([x, y]): HexPoint => [double(x), double(y)]);
    const outside = verifyAgreement(
      path,
      path.rule,
      { ...exact, mesh: { ...exact.mesh, vertices: scaled } },
      TAU,
    );
    expect(outside.withinBand).toBe(false);
    const changed = exact.points.map((vertex, index): HexPoint =>
      index === 0 ? [nextBits(vertex[0]), vertex[1]] : vertex,
    );
    expect(verifyAgreement(path, path.rule, { ...exact, points: changed }, TAU).samePolygon).toBe(
      false,
    );
    expect(verifyAgreement(path, path.rule, exact, TAU).withinBand).toBe(true);
  });

  it('mirrors the E8-U2 snap of source-final knots on an S1 view (SL-O3 amendment)', () => {
    // One contour: MOVE A, a cubic of two leaves ending near C, then LINE back to A with an
    // explicit close. The cubic's represented p3 is C; its final leaf was emitted as C'.
    const hex = (value: number) => bitsOf(value).toString(16).padStart(16, '0');
    const point = (x: number, y: number): HexPoint => [hex(x), hex(y)];
    const [a, b, c, cEmitted] = [
      point(0, 0),
      point(5, 7),
      point(10, 0),
      point(10.000000000000002, 0),
    ];
    const sources = [
      {
        kind: 'cubic' as const,
        sourceVerb: 1,
        contour: 0,
        points: [a, point(3, 9), point(7, 9), c],
      },
      { kind: 'line' as const, sourceVerb: 2, contour: 0, points: [c, a] },
    ];
    const owners = [
      { kind: 'cubicLeaf' as const, sourceVerb: 1, endNumerator: 1, depth: 1 },
      { kind: 'cubicLeaf' as const, sourceVerb: 1, endNumerator: 2, depth: 1 },
      { kind: 'line' as const, sourceVerb: 2 },
    ];
    const fast = { ranges: [[0, 3] as const], points: [a, b, cEmitted], owners, sources };
    const exact = { ranges: [[0, 3] as const], points: [a, b, c], owners, sources };
    expect(snapViewFinalKnots(fast)).toEqual(exact);
    // An internal knot is never moved: the snap of a view that differs there stays different.
    const internal = { ...fast, points: [a, point(5, 7.000000000000001), cEmitted] };
    expect(snapViewFinalKnots(internal)?.points[1]).toEqual(internal.points[1]);
    // A closing owner whose snapped start equals the first point is dropped with the point.
    const closing = {
      ranges: [[0, 3] as const],
      points: [c, b, cEmitted],
      owners: [owners[0]!, owners[1]!, { kind: 'explicitClose' as const, sourceVerb: 3 }],
      sources: [{ ...sources[0]!, points: [c, point(3, 9), point(7, 9), c] }],
    };
    expect(snapViewFinalKnots(closing)).toEqual({
      ranges: [[0, 2]],
      points: [c, b],
      owners: [owners[0], owners[1]],
      sources: closing.sources,
    });
  });

  it('classifies PREFIX and TRIANGLE fallbacks apart from conservative ones (section 4.1)', () => {
    const square = entry('SL-F5/nonzero');
    const certificate = verifyCertificate(square, delta);
    for (const reason of ['TRIANGLE', 'PREFIX'] as const) {
      const judgement = judgeRung({ ...square, rung: 'fallback', reason, mesh: null }, certificate);
      expect(judgement.reason).toBe('no-condition');
      // Conservative because every exact condition holds on SL-F5, not because of its reason.
      expect(judgement.conservative).toBe(true);
    }
    const structure = entry('SL-F14');
    const triangle = judgeRung(
      { ...structure, rung: 'fallback', reason: 'TRIANGLE' },
      verifyCertificate(structure, delta),
    );
    expect(triangle.conservative).toBe(false);
    expect(triangle.reason).toBe('no-condition');
    expect(triangle.unsound).toContain('SL-C0');
    // A fast entry is judged on every condition, and the parser rejects one stopped early.
    const early = raw.replace('"stop":"Fr8","rung":"fast"', '"stop":"Fr3","rung":"fast"');
    expect(early).not.toBe(raw);
    expect(() => parseSpikeFixtures(early)).toThrow('fast entry stopped before Fr8');
  });

  it('SL-A5: the oracles detect each seeded defect on its named fixture', () => {
    const report: string[] = [];
    const undetected: string[] = [];
    const defects = new Set<string>();
    for (const { defect, entry: faulty } of data.defects) {
      defects.add(defect);
      const base = entry(faulty.id);
      expect(base.rung === 'fast' || base.rung === 'fallback' || base.rung === 'none').toBe(true);
      const certificate = verifyCertificate(faulty, delta);
      const rejections = oracleRejections(faulty, certificate);
      const mismatch = literalMismatch(faulty, base.expected);
      const judgement = judgeRung(faulty, certificate);
      // Defect (5) only makes the rung more conservative: SL-F12 (a) falls back although every
      // exact condition holds, which the literal expectation and SL-O1's classification detect.
      const cause = DEFECT_CAUSES[`${defect} ${faulty.id}`];
      if (cause === undefined) throw new Error(`no expected cause for ${defect} ${faulty.id}`);
      const items =
        faulty.mesh === null ? [] : verifyRegionMesh(faulty, faulty.rule, faulty.mesh).failed;
      const detected =
        (cause.conservative === undefined ||
          (mismatch !== null &&
            judgement.conservative === true &&
            judgement.reason === 'reason-not-exact')) &&
        (cause.unsound === undefined || judgement.unsound.includes(cause.unsound)) &&
        (cause.items ?? []).every((item) => items.includes(item)) &&
        (cause.conservative !== undefined || rejections.length > 0);
      if (!detected)
        undetected.push(
          `${defect} ${faulty.id}: unsound [${judgement.unsound.join(', ')}], items [${items.join(', ')}]`,
        );
      report.push(
        `${defect} ${faulty.id}: ${faulty.rung}${faulty.reason ? ` ${faulty.reason}` : ''}; ` +
          `${rejections[0] ?? `literal: ${mismatch}; SL-O1 conservative ${judgement.conservative}, reason ${judgement.reason}`}`,
      );
    }
    console.log(`SL-A5 seeded defects:\n${report.join('\n')}`);
    expect([...defects]).toEqual([
      '(1)',
      '(2)',
      '(3)',
      '(4)',
      '(5)',
      '(6)',
      '(7)',
      '(8)',
      '(9)',
      '(10)',
    ]);
    expect(undetected).toEqual([]);
    expect(data.defects.map(({ defect, entry: faulty }) => `${defect} ${faulty.id}`)).toEqual(
      Object.keys(DEFECT_CAUSES),
    );
  });

  it('SL-O5 reports sliver statistics for every fast mesh', () => {
    const rows: string[] = [];
    for (const fixture of fastEntries()) {
      const stats = sliverStatistics(fixture.mesh!);
      expect(stats.quality.min).toBeGreaterThan(0);
      expect(stats.quality.min).toBeLessThanOrEqual(1 + 1e-12);
      expect(stats.triangles).toBeGreaterThan(0);
      expect(stats.perTriangle).toHaveLength(stats.triangles);
      expect(Math.min(...stats.perTriangle.map(({ quality }) => quality))).toBe(stats.quality.min);
      expect(Math.min(...stats.perTriangle.map(({ angle }) => angle))).toBe(stats.angle.min);
      rows.push(
        `${fixture.id}: T ${stats.triangles}, ρ min ${stats.quality.min.toPrecision(4)} p5 ${stats.quality.p5.toPrecision(4)} ` +
          `median ${stats.quality.median.toPrecision(4)}, angle min ${stats.angle.min.toPrecision(4)}°, ` +
          `ρ<0.1 ${stats.below01}, ρ<0.01 ${stats.below001}, min altitude ${stats.minAltitude.toPrecision(4)}`,
      );
    }
    console.log(`SL-O5:\n${rows.join('\n')}`);
  });
});
