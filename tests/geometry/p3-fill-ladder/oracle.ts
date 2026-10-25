/**
 * P3 Alt-A1 unit AL-U2 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` section 4.2): the
 * permanent oracles of the production ladder, as extensions of the spike's SL-U2 verifiers in
 * `tests/geometry/p3-b0-spike/oracle.ts`, which this module imports unchanged:
 *
 * - **δ per path.** δ = 2^e from each entry's own tolerance exponent, exactly.
 * - **New stages and reasons.** `RANGE` (AL-FR0, before S1) and `MESH_CHECK` (AL-FR9, after
 *   FR8): `RANGE` is right exactly when e lies outside −511 ≤ e ≤ 510, and `MESH_CHECK` names no
 *   certificate condition (rung 0 passed FR1-FR8).
 * - **AL-M5 exactly.** For each degenerate-source close edge, with a = |k − m|², b the exact
 *   max over m of |d_m|² of e′ = [p, m] and D = δ², all exact rationals, δ̄(e′) + |k − m| < δ
 *   holds exactly when b < D, D + b − a > 0 and 4·D·b < (D + b − a)² (square √a < √D − √b
 *   twice; b < D is SL-C1's premise, checked here as well).
 *
 * `evaluateEntry` applies SL-O1 (with AL-FR0 and AL-M5), SL-O2 (with the edges-used-once check
 * of `boundaryEdges`), SL-O3 and AL-I3 to one dump entry.
 */
import {
  CONDITIONS,
  exactHex,
  exactPoint,
  judgeRung,
  restrictCubic,
  verifyAgreement,
  verifyCertificate,
  verifyRegionMesh,
  type AgreementResult,
  type CertificateResult,
  type Condition,
  type RegionResult,
  type SpikeEntry,
  type SpikeMesh,
  type SpikeView,
  type XPoint,
} from '../p3-b0-spike/oracle.js';
import {
  add,
  compare,
  div,
  mul,
  rational,
  sign,
  sub,
  ZERO,
  type Rational,
} from '../rounded-fill/exact.js';
import type { LadderEntry, LadderReason, Pair, Triangle } from './dump.js';

/** Contract section 3.2, AL-FR0. */
export const MIN_FAST_EXPONENT = -511;
export const MAX_FAST_EXPONENT = 510;

export function inFastRange(exponent: number): boolean {
  return exponent >= MIN_FAST_EXPONENT && exponent <= MAX_FAST_EXPONENT;
}

/** The exact rational 2^e. */
export function powerOfTwo(exponent: number): Rational {
  return exponent >= 0 ? rational(1n << BigInt(exponent)) : rational(1n, 1n << BigInt(-exponent));
}

function minus(a: XPoint, b: XPoint): XPoint {
  return { x: sub(a.x, b.x), y: sub(a.y, b.y), key: '' };
}

function norm2(a: XPoint): Rational {
  return add(mul(a.x, a.x), mul(a.y, a.y));
}

/** (wa · a + wb · b). */
function combine(a: XPoint, wa: Rational, b: XPoint, wb: Rational): XPoint {
  return {
    x: add(mul(wa, a.x), mul(wb, b.x)),
    y: add(mul(wa, a.y), mul(wb, b.y)),
    key: '',
  };
}

export type AlM5Result = Readonly<{
  /** True when AL-M5 holds exactly on every contracted contour; null when SL-C0 fails. */
  holds: boolean | null;
  details: readonly string[];
  contracted: number;
}>;

/** The AL-M5 condition in the exact squared form of contract section 4.2. */
export function alM5Holds(a: Rational, b: Rational, delta2: Rational): boolean {
  if (compare(b, delta2) >= 0) return false;
  const gap = sub(add(delta2, b), a);
  if (sign(gap) <= 0) return false;
  return compare(mul(rational(4n), mul(delta2, b)), mul(gap, gap)) < 0;
}

/**
 * AL-M5 on every degenerate-source close edge of `view`: e′ = [p, m] with p the start of the
 * edge before the close edge, k its end and m the MOVE point; γ_e′ is that edge's source piece
 * (a line source, or a cubic leaf restricted exactly by blossoming).
 */
export function verifyAlM5(
  view: SpikeView,
  delta: Rational,
  certificate: CertificateResult,
): AlM5Result {
  if (certificate.holds['SL-C0'] !== true) return { holds: null, details: [], contracted: 0 };
  const delta2 = mul(delta, delta);
  const details: string[] = [];
  let contracted = 0;
  for (const [contour, closure] of certificate.closures.entries()) {
    if (closure !== 'degenerate-source-close') continue;
    contracted += 1;
    const [start, count] = view.ranges[contour]!;
    const p = exactPoint(view.points[start + count - 2]!);
    const k = exactPoint(view.points[start + count - 1]!);
    const m = exactPoint(view.points[start]!);
    const owner = view.owners[start + count - 2]!;
    const label = `contour ${contour} AL-M5`;
    let deviations: readonly XPoint[];
    if (owner.kind === 'line') {
      const source = view.sources.find((item) => item.sourceVerb === owner.sourceVerb);
      if (source === undefined || source.kind !== 'line') {
        details.push(`${label}: no line source`);
        continue;
      }
      deviations = [
        minus(exactPoint(source.points[0]!), p),
        minus(exactPoint(source.points[1]!), m),
      ];
    } else if (owner.kind === 'cubicLeaf') {
      const source = view.sources.find((item) => item.sourceVerb === owner.sourceVerb);
      if (source === undefined || source.kind !== 'cubic') {
        details.push(`${label}: no cubic source`);
        continue;
      }
      const scale = 1n << BigInt(owner.depth);
      const n = BigInt(owner.endNumerator);
      const [r0, r1, r2, r3] = restrictCubic(
        source.points.map(exactPoint),
        rational(n - 1n, scale),
        rational(n, scale),
      );
      const third = rational(1n, 3n);
      const twoThirds = rational(2n, 3n);
      deviations = [
        minus(r0, p),
        minus(r1, combine(p, twoThirds, m, third)),
        minus(r2, combine(p, third, m, twoThirds)),
        minus(r3, m),
      ];
    } else {
      details.push(`${label}: the edge before the close edge is a close edge`);
      continue;
    }
    let b = ZERO;
    for (const deviation of deviations) {
      const squared = norm2(deviation);
      if (compare(squared, b) > 0) b = squared;
    }
    const a = norm2(minus(k, m));
    if (!alM5Holds(a, b, delta2)) details.push(`${label}: δ̄(e′) + |k − m| ≥ δ`);
  }
  return { holds: details.length === 0, details, contracted };
}

export type LadderCertificate = CertificateResult & Readonly<{ alM5: AlM5Result; delta: Rational }>;

/** SL-O1 at the entry's own δ = 2^e, with AL-M5. */
export function verifyLadderCertificate(view: SpikeView, exponent: number): LadderCertificate {
  const delta = powerOfTwo(exponent);
  const certificate = verifyCertificate(view, delta);
  return { ...certificate, alM5: verifyAlM5(view, delta, certificate), delta };
}

export type LadderCondition = Condition | 'AL-M5' | 'AL-FR0';

export type LadderJudgement = Readonly<{
  /** Conditions the rung passed that do not hold exactly: a soundness defect. */
  unsound: readonly LadderCondition[];
  /** For a certificate fallback: every exact condition, AL-M5 included, holds. */
  conservative: boolean | null;
  /** As the spike's, with `RANGE` judged on the exponent and `MESH_CHECK` naming no condition. */
  reason: 'exact' | 'reason-not-exact' | 'no-condition' | null;
}>;

/** The reasons whose stage follows FR3, so AL-M5 was passed. */
const AFTER_FR3: readonly LadderReason[] = [
  'MONOTONE',
  'CROSSING',
  'CLEARANCE',
  'TRIANGLE',
  'MESH_CHECK',
  'WORK',
];

/**
 * The rung's outcome against the exact certificate (spike section 4.1 with AL-FR0 and AL-M5).
 * `certificate` is null when the entry has no S1 view (a prefix failure).
 */
export function judgeLadder(
  outcome: Readonly<{ rung: 'fast' | 'fallback'; reason: LadderReason | null }>,
  certificate: LadderCertificate | null,
  exponent: number,
): LadderJudgement {
  if (!inFastRange(exponent))
    return outcome.reason === 'RANGE'
      ? { unsound: [], conservative: null, reason: 'exact' }
      : { unsound: ['AL-FR0'], conservative: null, reason: null };
  if (outcome.reason === 'RANGE')
    return { unsound: [], conservative: null, reason: 'reason-not-exact' };
  if (certificate === null)
    return outcome.rung === 'fast'
      ? { unsound: ['SL-C0'], conservative: null, reason: null }
      : {
          unsound: [],
          conservative: null,
          reason: outcome.reason === 'PREFIX' ? 'no-condition' : null,
        };
  // E14-K3's `WORK` is a cost bound raised in FR5 or FR7, after FR3: it names no condition.
  if (outcome.reason === 'WORK')
    return {
      unsound: certificate.alM5.holds === true ? [] : ['AL-M5'],
      conservative: null,
      reason: 'no-condition',
    };
  const spikeReason = outcome.reason === 'MESH_CHECK' ? 'TRIANGLE' : outcome.reason;
  const base = judgeRung(
    { rung: outcome.rung, reason: spikeReason, stop: 'Fr8' } as unknown as SpikeEntry,
    certificate,
  );
  const unsound: LadderCondition[] = [...base.unsound];
  const passedFr3 =
    outcome.rung === 'fast' || (outcome.reason !== null && AFTER_FR3.includes(outcome.reason));
  if (passedFr3 && certificate.alM5.holds !== true) unsound.push('AL-M5');
  let reason = base.reason;
  if (
    outcome.reason === 'CLOSURE' &&
    reason === 'reason-not-exact' &&
    certificate.alM5.holds === false
  )
    reason = 'exact';
  return {
    unsound,
    conservative:
      base.conservative === null ? null : base.conservative && certificate.alM5.holds === true,
    reason,
  };
}

/** The directed edges used exactly once, in triangle-slot order (V2 section f's scan). */
export function onceUsedEdges(triangles: readonly Triangle[]): Pair[] {
  const uses = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const triangle of triangles)
    for (let side = 0; side < 3; side += 1) {
      const edge = key(triangle[side]!, triangle[(side + 1) % 3]!);
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  const once: Pair[] = [];
  for (const triangle of triangles)
    for (let side = 0; side < 3; side += 1) {
      const a = triangle[side]!;
      const b = triangle[(side + 1) % 3]!;
      if (uses.get(key(a, b)) === 1) once.push([a, b]);
    }
  return once;
}

/** `boundaryEdges` must equal the edges used once, pair for pair and in order. */
export function verifyBoundaryEdges(
  triangles: readonly Triangle[],
  boundaryEdges: readonly Pair[],
): string[] {
  const expected = onceUsedEdges(triangles);
  return JSON.stringify(expected) === JSON.stringify(boundaryEdges)
    ? []
    : [
        `boundaryEdges (${boundaryEdges.length} pairs) differ from the ${expected.length} edges used once`,
      ];
}

export type OracleGate = 'SL-O1' | 'SL-O2' | 'SL-O3' | 'AL-I3' | 'harness';
export const ORACLE_GATES: readonly OracleGate[] = ['SL-O1', 'SL-O2', 'SL-O3', 'AL-I3', 'harness'];

export type EntryEvaluation = Readonly<{
  failures: Readonly<Record<OracleGate, readonly string[]>>;
  checked: Readonly<Record<'SL-O1' | 'SL-O2' | 'SL-O3' | 'AL-I3', boolean>>;
  certificate: LadderCertificate | null;
  judgement: LadderJudgement | null;
  region: RegionResult | null;
  agreement: AgreementResult | null;
  /** An allowed AL-I3 difference: `RANGE` outside the range or an AL-M5 `CLOSURE`. */
  allowedDifference: 'RANGE' | 'AL-M5' | null;
  /** The fast output the oracles judged: the module's (revision 1) or the export's. */
  fastOutput: Readonly<{ mesh: SpikeMesh; boundaryEdges: readonly Pair[] }> | null;
}>;

/**
 * The published fast output of an entry. With revision 1 the export does not run the ladder,
 * so it is the module's fast mesh and scan; from revision 2 it is the export's output.
 */
export function fastOutput(entry: LadderEntry, revision: number): EntryEvaluation['fastOutput'] {
  if (entry.rung !== 'fast' || entry.fastMesh === null || entry.boundaryEdges === null) return null;
  if (revision < 2 || entry.kind === 'view')
    return { mesh: entry.fastMesh, boundaryEdges: entry.boundaryEdges };
  const exported = entry.export;
  if (
    exported === null ||
    exported.positions === null ||
    exported.triangles === null ||
    exported.boundaryEdges === null
  )
    return null;
  return {
    mesh: { vertices: exported.positions, triangles: exported.triangles },
    boundaryEdges: exported.boundaryEdges,
  };
}

/** The ladder's AL-I3 judgement of one entry against the frozen spike's rung 0. */
export function judgeDifferential(entry: LadderEntry): string {
  const { spike } = entry;
  if (entry.rung === 'fast' && spike.rung === 'fast' && spike.sameMesh) return 'identical';
  if (entry.rung === 'fallback' && spike.rung === 'fallback' && entry.reason === spike.reason)
    return 'identical';
  if (entry.reason === 'RANGE' && !inFastRange(entry.exponent)) return 'RANGE';
  if (entry.reason === 'CLOSURE' && spike.passesFr3) return 'AL-M5';
  return `production ${entry.rung} ${entry.reason ?? ''} against spike ${spike.rung} ${spike.reason ?? ''}`.trim();
}

/** SL-O1, SL-O2, SL-O3, AL-I3 and the harness checks of one entry (contract section 4.2). */
export function evaluateEntry(entry: LadderEntry, revision: number): EntryEvaluation {
  const failures: Record<OracleGate, string[]> = {
    'SL-O1': [],
    'SL-O2': [],
    'SL-O3': [],
    'AL-I3': [],
    harness: [],
  };
  const checked = { 'SL-O1': false, 'SL-O2': false, 'SL-O3': false, 'AL-I3': false };
  // Harness: no allocation inside the ladder call; the ladder's exact result is the exact rung
  // run alone (module-level AL-I2); `MESH_CHECK` stays a zero count outside seeded defects.
  if (entry.allocations !== 0) failures.harness.push(`${entry.allocations} allocations`);
  if (entry.ladderExactAgrees === false)
    failures.harness.push('the ladder exact result differs from the exact rung alone');
  if (entry.reason === 'MESH_CHECK' && entry.faults.length === 0)
    failures.harness.push(`MESH_CHECK from AL-FR9 item ${entry.meshCheckItem}`);

  // SL-O1 with AL-FR0 and AL-M5, at the entry's own δ.
  let certificate: LadderCertificate | null = null;
  if (entry.view !== null && entry.reason !== 'PREFIX' && entry.reason !== 'RANGE') {
    try {
      certificate = verifyLadderCertificate(entry.view, entry.exponent);
    } catch (error) {
      failures['SL-O1'].push(`oracle error ${(error as Error).message}`);
    }
  }
  const judgement = judgeLadder(entry, certificate, entry.exponent);
  checked['SL-O1'] = certificate !== null || !inFastRange(entry.exponent);
  for (const condition of judgement.unsound) {
    const detail =
      condition === 'AL-FR0'
        ? `exponent ${entry.exponent} outside the range without RANGE`
        : condition === 'AL-M5'
          ? (certificate?.alM5.details.join('; ') ?? 'unevaluated')
          : (certificate?.details[condition] ?? 'unevaluated');
    failures['SL-O1'].push(`${condition} passed by the rung fails exactly (${detail})`);
  }
  // A conservative fallback is allowed (the condition is sufficient, not necessary), but RANGE
  // is decided on the exponent alone and must be exact.
  if (entry.reason === 'RANGE' && judgement.reason !== 'exact')
    failures['SL-O1'].push(`RANGE at exponent ${entry.exponent}, inside the range`);
  if (entry.rung === 'fast' && certificate !== null) {
    const exactMax = certificate.maxDeviationSquared;
    if (entry.maxDeviationSquared === null || exactMax === null)
      failures['SL-O1'].push('no deviation bound');
    else {
      const certified = exactHex(entry.maxDeviationSquared);
      if (compare(exactMax, certified) > 0)
        failures['SL-O1'].push('exact max |d_m|² exceeds the certified bound');
      if (compare(certified, mul(certificate.delta, certificate.delta)) >= 0)
        failures['SL-O1'].push('the certified bound is not below δ²');
    }
  }

  // SL-O2 on the published fast output, with `boundaryEdges`.
  let region: RegionResult | null = null;
  const output = fastOutput(entry, revision);
  if (entry.rung === 'fast') {
    checked['SL-O2'] = true;
    if (entry.view === null || output === null)
      failures['SL-O2'].push('fast entry without a view or a published output');
    else {
      region = verifyRegionMesh(entry.view, entry.rule, output.mesh);
      failures['SL-O2'].push(...region.issues);
      failures['SL-O2'].push(...verifyBoundaryEdges(output.mesh.triangles, output.boundaryEdges));
      if (
        revision >= 2 &&
        entry.kind === 'path' &&
        JSON.stringify([output.mesh, output.boundaryEdges]) !==
          JSON.stringify([entry.fastMesh, entry.boundaryEdges])
      )
        failures['SL-O2'].push('the export output differs from the module fast mesh');
    }
  }

  // SL-O3 on paths both rungs admit: the same input polygon and the exact area band.
  let agreement: AgreementResult | null = null;
  const exact = entry.exact;
  if (
    entry.rung === 'fast' &&
    entry.view !== null &&
    exact !== null &&
    exact.status === 'OK' &&
    exact.published !== null &&
    exact.mesh !== null
  ) {
    checked['SL-O3'] = true;
    agreement = verifyAgreement(
      entry.view,
      entry.rule,
      { ...exact.published, mesh: exact.mesh },
      powerOfTwo(entry.exponent - 1),
    );
    if (!agreement.samePolygon) failures['SL-O3'].push('exact polygon differs from the S1 view');
    if (!agreement.withinBand) failures['SL-O3'].push('exact mesh area outside the τ band');
  }

  // AL-I3 against the frozen spike module (seeded-defect entries change rung 0 on purpose).
  let allowedDifference: EntryEvaluation['allowedDifference'] = null;
  if (entry.faults.length === 0) {
    checked['AL-I3'] = true;
    const verdict = judgeDifferential(entry);
    if (verdict === 'RANGE' || verdict === 'AL-M5') allowedDifference = verdict;
    else if (verdict !== 'identical') failures['AL-I3'].push(verdict);
  }
  return {
    failures,
    checked,
    certificate,
    judgement,
    region,
    agreement,
    allowedDifference,
    fastOutput: output,
  };
}

/** All failures of an evaluation, tagged by gate. */
export function evaluationFailures(evaluation: EntryEvaluation): string[] {
  return Object.entries(evaluation.failures).flatMap(([gate, items]) =>
    items.map((item) => `${gate}: ${item}`),
  );
}

/** Every condition SL-O1 checks on a fast entry (the spike's six, then AL-M5 and AL-FR0). */
export const LADDER_CONDITIONS: readonly LadderCondition[] = [...CONDITIONS, 'AL-M5', 'AL-FR0'];

/** The quotient of two rationals as a float, for reports only. */
export function ratio(value: Rational, unit: Rational): number {
  const quotient = div(value, unit);
  return Number(quotient.n) / Number(quotient.d);
}
