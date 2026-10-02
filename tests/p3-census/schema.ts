import type {
  CubicBoundaryStatus,
  CubicBoundaryResult,
} from '../geometry/cubic-boundary/oracle.js';
import type {
  CubicPreparationFinding,
  CubicPreparationStatus,
} from '../geometry/simple-cubic-topology/oracle.js';

export type SerializedRational = Readonly<{ numerator: string; denominator: string }>;
export type CensusBoundary = Readonly<{
  status: CubicBoundaryStatus;
  cells: number;
  finding: string | null;
  maxCertifiedSquared: SerializedRational | null;
}>;
export type CensusRow = Readonly<{
  index: number;
  nodeId: string;
  requestId: number;
  sourceEpoch: number;
  sourceRevision: number;
  sourceSha256: string;
  inputFrameSha256: string;
  outputFrameSha256: string;
  batchStatus: 0;
  pathStatus: 0;
  abiVerified: true;
  sourceCaps: Readonly<{
    verbs: number;
    scalars: number;
    maxVerbs: 24;
    maxScalars: 104;
    verdict: 'WITHIN_CHEAP_CAPS' | 'EXCEEDS_CHEAP_CAPS';
  }>;
  emittedLines: number;
  implicitClosureEdges: 0 | 1;
  prospectiveEdges: number;
  maxDepth: number;
  depthHistogram: readonly number[];
  cubics: readonly Readonly<{
    sourceVerbOrdinal: number;
    leaves: number;
    boundary: CensusBoundary;
  }>[];
  preparation: Readonly<{
    status: CubicPreparationStatus;
    finding: CubicPreparationFinding | null;
  }>;
  prospectivePairs: number;
  pairStage: 'NOT_EVALUATED';
}>;

type LocatedMaximum = Readonly<{ value: number; index: number; sourceVerbOrdinal?: number }>;
export type CensusSummary = Readonly<{
  rows: number;
  boundaryStatusCounts: Readonly<Record<string, number>>;
  preparationStatusCounts: Readonly<Record<string, number>>;
  sourceCapCounts: Readonly<Record<string, number>>;
  boundaryCells: Readonly<{
    total: number;
    max: Readonly<{ value: number; index: number; sourceVerbOrdinal: number }>;
  }>;
  maxCertifiedSquared: Readonly<{
    value: SerializedRational;
    index: number;
    sourceVerbOrdinal: number;
  }> | null;
  emittedLines: Readonly<{ min: number; max: number; total: number }>;
  depthHistogram: readonly number[];
  maxDepth: number;
  implicitClosureEdges: number;
  prospectiveEdges: Readonly<{ total: number; max: LocatedMaximum }>;
  prospectivePairs: Readonly<{ total: number; max: LocatedMaximum }>;
}>;

export function serializeBoundary(result: CubicBoundaryResult): CensusBoundary {
  return {
    status: result.status,
    cells: result.cells,
    finding: result.finding,
    maxCertifiedSquared:
      result.maxCertifiedSquared === null
        ? null
        : {
            numerator: result.maxCertifiedSquared.n.toString(),
            denominator: result.maxCertifiedSquared.d.toString(),
          },
  };
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function largerRational(left: SerializedRational, right: SerializedRational): boolean {
  return (
    BigInt(left.numerator) * BigInt(right.denominator) >
    BigInt(right.numerator) * BigInt(left.denominator)
  );
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a safe count`);
  return value;
}

export function summarizeRows(rows: readonly CensusRow[]): CensusSummary {
  if (rows.length === 0) throw new Error('cannot summarize an empty census');
  const boundaryStatuses = new Map<string, number>();
  const preparationStatuses = new Map<string, number>();
  const sourceCaps = new Map<string, number>();
  const depths = Array.from({ length: 21 }, () => 0);
  let boundaryTotal = 0;
  let boundaryMax = { value: -1, index: 0, sourceVerbOrdinal: 0 };
  let maximumCertified: CensusSummary['maxCertifiedSquared'] = null;
  let emittedMin = Number.POSITIVE_INFINITY;
  let emittedMax = 0;
  let emittedTotal = 0;
  let maxDepth = 0;
  let closures = 0;
  let edgeTotal = 0;
  let edgeMax = { value: -1, index: 0 };
  let pairTotal = 0;
  let pairMax = { value: -1, index: 0 };
  rows.forEach((row, rowIndex) => {
    if (row.index !== rowIndex) throw new Error('census rows are not in source order');
    increment(preparationStatuses, row.preparation.status);
    increment(sourceCaps, row.sourceCaps.verdict);
    emittedMin = Math.min(emittedMin, row.emittedLines);
    emittedMax = Math.max(emittedMax, row.emittedLines);
    emittedTotal = safeAdd(emittedTotal, row.emittedLines, 'emitted line total');
    maxDepth = Math.max(maxDepth, row.maxDepth);
    closures = safeAdd(closures, row.implicitClosureEdges, 'closure total');
    edgeTotal = safeAdd(edgeTotal, row.prospectiveEdges, 'edge total');
    pairTotal = safeAdd(pairTotal, row.prospectivePairs, 'pair total');
    if (row.prospectiveEdges > edgeMax.value)
      edgeMax = { value: row.prospectiveEdges, index: row.index };
    if (row.prospectivePairs > pairMax.value)
      pairMax = { value: row.prospectivePairs, index: row.index };
    row.depthHistogram.forEach((count, depth) => {
      depths[depth] = safeAdd(depths[depth]!, count, `depth ${depth} total`);
    });
    row.cubics.forEach((cubic) => {
      increment(boundaryStatuses, cubic.boundary.status);
      boundaryTotal = safeAdd(boundaryTotal, cubic.boundary.cells, 'boundary cell total');
      if (cubic.boundary.cells > boundaryMax.value) {
        boundaryMax = {
          value: cubic.boundary.cells,
          index: row.index,
          sourceVerbOrdinal: cubic.sourceVerbOrdinal,
        };
      }
      const value = cubic.boundary.maxCertifiedSquared;
      if (
        value !== null &&
        (maximumCertified === null || largerRational(value, maximumCertified.value))
      ) {
        maximumCertified = { value, index: row.index, sourceVerbOrdinal: cubic.sourceVerbOrdinal };
      }
    });
  });
  return {
    rows: rows.length,
    boundaryStatusCounts: sortedCounts(boundaryStatuses),
    preparationStatusCounts: sortedCounts(preparationStatuses),
    sourceCapCounts: sortedCounts(sourceCaps),
    boundaryCells: { total: boundaryTotal, max: boundaryMax },
    maxCertifiedSquared: maximumCertified,
    emittedLines: { min: emittedMin, max: emittedMax, total: emittedTotal },
    depthHistogram: depths,
    maxDepth,
    implicitClosureEdges: closures,
    prospectiveEdges: { total: edgeTotal, max: edgeMax },
    prospectivePairs: { total: pairTotal, max: pairMax },
  };
}

export function assertRowShape(value: unknown): asserts value is CensusRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('census row must be an object');
  const row = value as Record<string, unknown>;
  const expected = [
    'abiVerified',
    'batchStatus',
    'cubics',
    'depthHistogram',
    'emittedLines',
    'implicitClosureEdges',
    'index',
    'inputFrameSha256',
    'maxDepth',
    'nodeId',
    'outputFrameSha256',
    'pairStage',
    'pathStatus',
    'preparation',
    'prospectiveEdges',
    'prospectivePairs',
    'requestId',
    'sourceCaps',
    'sourceEpoch',
    'sourceRevision',
    'sourceSha256',
  ];
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expected))
    throw new Error('census row keys mismatch');
  if (
    row.abiVerified !== true ||
    row.batchStatus !== 0 ||
    row.pathStatus !== 0 ||
    row.pairStage !== 'NOT_EVALUATED'
  )
    throw new Error('census row fixed status mismatch');
  if (!Array.isArray(row.depthHistogram) || row.depthHistogram.length !== 21)
    throw new Error('census depth histogram shape mismatch');
  const integer = (entry: unknown, label: string): number => {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0)
      throw new Error(`${label} must be a nonnegative safe integer`);
    return entry;
  };
  const exactKeys = (entry: unknown, label: string, keys: readonly string[]) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new Error(`${label} must be an object`);
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([...keys].sort()))
      throw new Error(`${label} keys mismatch`);
    return entry as Record<string, unknown>;
  };
  const hash = (entry: unknown, label: string) => {
    if (typeof entry !== 'string' || !/^[0-9a-f]{64}$/u.test(entry))
      throw new Error(`${label} must be a SHA-256 digest`);
  };
  integer(row.index, 'index');
  integer(row.requestId, 'requestId');
  integer(row.sourceEpoch, 'sourceEpoch');
  integer(row.sourceRevision, 'sourceRevision');
  hash(row.sourceSha256, 'sourceSha256');
  hash(row.inputFrameSha256, 'inputFrameSha256');
  hash(row.outputFrameSha256, 'outputFrameSha256');
  if (typeof row.nodeId !== 'string' || row.nodeId.length === 0) throw new Error('nodeId invalid');
  const caps = exactKeys(row.sourceCaps, 'sourceCaps', [
    'verbs',
    'scalars',
    'maxVerbs',
    'maxScalars',
    'verdict',
  ]);
  const verbs = integer(caps.verbs, 'sourceCaps.verbs');
  const scalars = integer(caps.scalars, 'sourceCaps.scalars');
  if (caps.maxVerbs !== 24 || caps.maxScalars !== 104)
    throw new Error('sourceCaps fixed limits mismatch');
  const verdict = verbs <= 24 && scalars <= 104 ? 'WITHIN_CHEAP_CAPS' : 'EXCEEDS_CHEAP_CAPS';
  if (caps.verdict !== verdict) throw new Error('sourceCaps verdict mismatch');
  const emitted = integer(row.emittedLines, 'emittedLines');
  if (emitted === 0 || emitted > 4096) throw new Error('emittedLines outside frozen bounds');
  const closure = integer(row.implicitClosureEdges, 'implicitClosureEdges');
  if (closure > 1) throw new Error('implicitClosureEdges exceeds one');
  const edges = integer(row.prospectiveEdges, 'prospectiveEdges');
  if (edges !== emitted + closure) throw new Error('prospectiveEdges arithmetic mismatch');
  const pairs = integer(row.prospectivePairs, 'prospectivePairs');
  if (pairs !== (edges * (edges - 1)) / 2) throw new Error('prospectivePairs arithmetic mismatch');
  const maximumDepth = integer(row.maxDepth, 'maxDepth');
  if (maximumDepth > 7) throw new Error('maxDepth outside frozen bounds');
  let histogramTotal = 0;
  let histogramMaximum = 0;
  row.depthHistogram.forEach((count, depth) => {
    histogramTotal = safeAdd(
      histogramTotal,
      integer(count, `depthHistogram[${depth}]`),
      'histogram',
    );
    if (count !== 0) histogramMaximum = depth;
  });
  if (histogramTotal !== emitted || histogramMaximum !== maximumDepth)
    throw new Error('depth histogram arithmetic mismatch');
  if (!Array.isArray(row.cubics) || row.cubics.length === 0 || row.cubics.length > 32)
    throw new Error('cubics outside frozen bounds');
  let leaves = 0;
  const boundaryStatuses = new Set([
    'CERTIFIED',
    'INVALID_LIMITS',
    'INVALID_INPUT',
    'INVALID_PROVENANCE',
    'LOCAL_KNOT_ERROR',
    'PHYSICAL_ERROR',
    'UNRESOLVED',
    'WORK_LIMIT',
  ]);
  row.cubics.forEach((entry, cubicIndex) => {
    const cubic = exactKeys(entry, `cubics[${cubicIndex}]`, [
      'sourceVerbOrdinal',
      'leaves',
      'boundary',
    ]);
    if (
      integer(cubic.sourceVerbOrdinal, `cubics[${cubicIndex}].sourceVerbOrdinal`) !==
      cubicIndex + 1
    )
      throw new Error('sourceVerbOrdinal order mismatch');
    const cubicLeaves = integer(cubic.leaves, `cubics[${cubicIndex}].leaves`);
    if (cubicLeaves === 0 || cubicLeaves > 128)
      throw new Error('cubic leaves outside frozen bounds');
    leaves = safeAdd(leaves, cubicLeaves, 'leaves');
    const boundary = exactKeys(cubic.boundary, `cubics[${cubicIndex}].boundary`, [
      'status',
      'cells',
      'finding',
      'maxCertifiedSquared',
    ]);
    if (typeof boundary.status !== 'string' || !boundaryStatuses.has(boundary.status))
      throw new Error('unknown boundary status');
    if (integer(boundary.cells, `cubics[${cubicIndex}].boundary.cells`) > 1_048_576)
      throw new Error('boundary cells outside frozen bounds');
    if (boundary.finding !== null && typeof boundary.finding !== 'string')
      throw new Error('boundary finding must be a string or null');
    if (boundary.status === 'CERTIFIED') {
      if (boundary.finding !== null) throw new Error('certified boundary has a finding');
      const rational = exactKeys(boundary.maxCertifiedSquared, 'maxCertifiedSquared', [
        'numerator',
        'denominator',
      ]);
      if (
        typeof rational.numerator !== 'string' ||
        typeof rational.denominator !== 'string' ||
        !/^(0|[1-9][0-9]*)$/u.test(rational.numerator) ||
        !/^[1-9][0-9]*$/u.test(rational.denominator)
      )
        throw new Error('noncanonical rational');
      const numerator = BigInt(rational.numerator);
      const denominator = BigInt(rational.denominator);
      if (numerator * 64n > denominator)
        throw new Error('certified squared bound exceeds tolerance');
      const gcd = (left: bigint, right: bigint): bigint => {
        let a = left < 0n ? -left : left;
        let b = right;
        while (b !== 0n) [a, b] = [b, a % b];
        return a;
      };
      if (gcd(numerator, denominator) !== 1n) throw new Error('rational is not normalized');
    } else {
      if (boundary.maxCertifiedSquared !== null)
        throw new Error('failed boundary publishes a certificate');
      if (typeof boundary.finding !== 'string' || boundary.finding.length === 0)
        throw new Error('failed boundary has no finding');
    }
  });
  if (leaves !== emitted) throw new Error('cubic leaves differ from emittedLines');
  const preparation = exactKeys(row.preparation, 'preparation', ['status', 'finding']);
  const preparationStatuses = new Set([
    'PREPARED',
    'INVALID_INPUT',
    'INVALID_PROVENANCE',
    'KNOT_MISMATCH',
    'PROJECTION_UNRESOLVED',
    'WORK_LIMIT',
  ]);
  if (typeof preparation.status !== 'string' || !preparationStatuses.has(preparation.status))
    throw new Error('unknown preparation status');
  if ((preparation.status === 'PREPARED') !== (preparation.finding === null))
    throw new Error('preparation finding/status mismatch');
  if (preparation.finding !== null) {
    const finding = exactKeys(preparation.finding, 'preparation.finding', [
      'code',
      'segmentIndex',
      'sourceVerbOrdinal',
      'lineIndex',
      'endpoint',
    ]);
    const codes = new Set([
      'CONTOUR_SHAPE',
      'SEGMENT_SHAPE',
      'LINE_SHAPE',
      'SOURCE_CAP',
      'LINE_CAP',
      'CUBIC',
      'ORDINAL',
      'CONNECTIVITY',
      'ENDPOINT',
      'PROVENANCE',
      'KNOT',
      'PROJECTION',
    ]);
    if (typeof finding.code !== 'string' || !codes.has(finding.code))
      throw new Error('unknown preparation finding code');
    for (const key of ['segmentIndex', 'sourceVerbOrdinal', 'lineIndex'] as const) {
      if (finding[key] !== null) integer(finding[key], `preparation.finding.${key}`);
    }
    if (finding.endpoint !== null && finding.endpoint !== 'start' && finding.endpoint !== 'end')
      throw new Error('unknown preparation endpoint role');
  }
}
