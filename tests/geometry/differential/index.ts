import {
  CONTINUOUS_ERROR_POSITIVE_CONTROLS,
  generateP2GeometryCorpus,
  METAMORPHIC_CUBIC_FIXTURES,
  NAMED_CUBIC_FIXTURES,
  NAMED_PACKED_FIXTURES,
  referenceCubicBounds,
  referencePackedPathBounds,
  screenTolerance,
  SUBDIVISION_METAMORPHIC_FIXTURE,
  validateContinuousCubicError,
  validateReferenceBounds,
  type Bounds,
  type CanonicalPackedInput,
  type Cubic,
  type Matrix2,
  type ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/index.js';

const INPUT_MAGIC = 0x3253_4756;
const OUTPUT_MAGIC = 0x3252_4756;
const ABI_VERSION = 1;
const HEADER_BYTES = 48;
const REQUEST_BYTES = 24;
const RESULT_BYTES = 64;
const PROVENANCE_BYTES = 12;
const BATCH_OK = 0;
const BATCH_INVALID = 1;
const FROZEN_CORPUS = generateP2GeometryCorpus();

type PathExpectation = Readonly<{
  status: number;
  cubics?: readonly Readonly<{ cubic: Cubic; sourceVerbOrdinal: number }>[];
  screen?: Matrix2;
}>;

export type DifferentialCase = Readonly<{
  id: string;
  category: 'corpus' | 'named-cubic' | 'named-packed' | 'metamorphic' | 'subdivision' | 'edge';
  input: CanonicalPackedInput;
  metadata: Readonly<Record<string, unknown>>;
  expectedBatchStatus: number;
  paths: readonly PathExpectation[];
  relation?: 'reverse' | 'translate' | 'uniform-scale' | 'subdivision';
}>;

export type DifferentialVerificationSummary = Readonly<{
  id: string;
  pathCount: number;
  successfulPaths: number;
  emittedLines: number;
}>;

export type PositiveControlSummary = Readonly<{
  attempted: number;
  rejected: number;
}>;

type DecodedPath = Readonly<{
  status: number;
  bounds: Bounds;
  verbs: readonly number[];
  points: readonly number[];
  provenance: readonly number[];
}>;

export class DifferentialVerificationError extends Error {
  constructor(testCase: DifferentialCase, detail: string) {
    super(`${detail}\ncase=${stringifyMetadata(testCase)}`);
    this.name = 'DifferentialVerificationError';
  }
}

const align = (value: number, alignment: number) => Math.ceil(value / alignment) * alignment;
const identity: Matrix2 = [1, 0, 0, 1];

function request(requestId: number, tolerance: number) {
  return { requestId, sourceEpoch: 1, sourceRevision: 1, bucketTolerance: tolerance };
}

function cubicInput(cubics: readonly Cubic[], tolerances: readonly number[]): CanonicalPackedInput {
  const requests = cubics.map((_, index) => request(index + 1, tolerances[index] ?? 0.25));
  const verbs: number[] = [];
  const points: number[] = [];
  const pathOffsets = [0];
  const pointOffsets = [0];
  for (const cubic of cubics) {
    verbs.push(0, 2);
    points.push(...cubic.flat());
    pathOffsets.push(verbs.length);
    pointOffsets.push(points.length);
  }
  return { requests, pathOffsets, pointOffsets, verbs, points };
}

function cubicExpectation(cubic: Cubic, screen: Matrix2 = identity): PathExpectation {
  return { status: 0, cubics: [{ cubic, sourceVerbOrdinal: 1 }], screen };
}

function namedPackedExpectations(input: CanonicalPackedInput, statuses: readonly number[]) {
  return statuses.map((status, pathIndex): PathExpectation =>
    status === 0
      ? { status, cubics: extractCubics(input, pathIndex), screen: identity }
      : { status },
  );
}

function corpusCases(): DifferentialCase[] {
  return FROZEN_CORPUS.map((fixture) => {
    const tolerance = screenTolerance(fixture.world, fixture.zoom, fixture.dpr);
    if (!tolerance.ok) throw new Error(tolerance.finding);
    return {
      id: `corpus/${fixture.index}`,
      category: 'corpus',
      input: cubicInput([fixture.cubic], [fixture.bucketTolerance]),
      metadata: {
        version: fixture.version,
        index: fixture.index,
        seed: fixture.seed,
        seedIndex: fixture.seedIndex,
        cubic: fixture.cubic,
        localTransform: fixture.localTransform,
        world: fixture.world,
        zoom: fixture.zoom,
        dpr: fixture.dpr,
        bucketTolerance: fixture.bucketTolerance,
      },
      expectedBatchStatus: BATCH_OK,
      paths: [cubicExpectation(fixture.cubic, tolerance.screen)],
    };
  });
}

function namedCubicCases(): DifferentialCase[] {
  return NAMED_CUBIC_FIXTURES.map((fixture) => ({
    id: `named-cubic/${fixture.name}`,
    category: 'named-cubic',
    input: cubicInput([fixture.cubic], [0.25]),
    metadata: { name: fixture.name, cubic: fixture.cubic, expectation: fixture.expectation },
    expectedBatchStatus: BATCH_OK,
    paths: [
      fixture.expectation === 'success'
        ? cubicExpectation(fixture.cubic)
        : ({ status: 4 } satisfies PathExpectation),
    ],
  }));
}

function namedPackedCases(): DifferentialCase[] {
  return NAMED_PACKED_FIXTURES.map((fixture) => {
    const reference = referencePackedPathBounds(fixture.input);
    const statuses = reference.ok ? reference.paths.map((path) => path.status) : [];
    return {
      id: `named-packed/${fixture.name}`,
      category: 'named-packed',
      input: fixture.input,
      metadata: {
        name: fixture.name,
        envelopeValid: fixture.envelopeValid,
        expectedStatuses: fixture.statuses,
      },
      expectedBatchStatus: fixture.envelopeValid ? BATCH_OK : BATCH_INVALID,
      paths: fixture.envelopeValid
        ? namedPackedExpectations(fixture.input, fixture.statuses ?? statuses)
        : [],
    };
  });
}

function metamorphicCases(): DifferentialCase[] {
  return METAMORPHIC_CUBIC_FIXTURES.map((fixture) => ({
    id: `metamorphic/${fixture.name}`,
    category: 'metamorphic',
    input: cubicInput([fixture.source, fixture.transformed], [0.25, 0.25]),
    metadata: {
      name: fixture.name,
      transform: fixture.transform,
      source: fixture.source,
      transformed: fixture.transformed,
    },
    expectedBatchStatus: BATCH_OK,
    paths: [cubicExpectation(fixture.source), cubicExpectation(fixture.transformed)],
    relation: fixture.transform,
  }));
}

function subdivisionCase(): DifferentialCase {
  const fixture = SUBDIVISION_METAMORPHIC_FIXTURE;
  return {
    id: `subdivision/${fixture.name}`,
    category: 'subdivision',
    input: cubicInput([fixture.source, ...fixture.halves], [0.25, 0.25, 0.25]),
    metadata: { name: fixture.name, source: fixture.source, halves: fixture.halves },
    expectedBatchStatus: BATCH_OK,
    paths: [
      cubicExpectation(fixture.source),
      cubicExpectation(fixture.halves[0]),
      cubicExpectation(fixture.halves[1]),
    ],
    relation: 'subdivision',
  };
}

function edgeCases(): DifferentialCase[] {
  const base: Cubic = [
    [0, 0],
    [1, 3],
    [2, -3],
    [3, 0],
  ];
  const adjacentInput: CanonicalPackedInput = {
    requests: [request(1, 0.25)],
    pathOffsets: [0, 3],
    pointOffsets: [0, 14],
    verbs: [0, 2, 2],
    points: [0, 0, 1, 8, 2, -8, 3, 0, 3.1, 0.01, 3.2, -0.01, 4, 0],
  };
  const adjacentCubics = extractCubics(adjacentInput, 0);
  const zeroTolerance = screenTolerance([0, 0, 0, 0], 1, 1);
  const rankOneTolerance = screenTolerance([1, 2, 0, 0], 1, 1);
  if (!zeroTolerance.ok || !rankOneTolerance.ok) throw new Error('edge tolerance setup failed');
  const bucketNeighbors = [1 - 2 ** -20, 1, 1 + 2 ** -20].map((zoom) => {
    const tolerance = screenTolerance(identity, zoom, 1);
    if (!tolerance.ok) throw new Error(tolerance.finding);
    return { zoom, tolerance };
  });
  const maximumLeafFixture = FROZEN_CORPUS[6059];
  if (!maximumLeafFixture) throw new Error('frozen corpus index 6059 is absent');
  const outputRetryInput: CanonicalPackedInput = {
    requests: [request(1, maximumLeafFixture.bucketTolerance)],
    pathOffsets: [0, 4],
    pointOffsets: [0, 16],
    verbs: [0, 2, 0, 2],
    points: [...maximumLeafFixture.cubic.flat(), ...maximumLeafFixture.cubic.flat()],
  };
  const mixedNonfiniteInput: CanonicalPackedInput = {
    requests: [request(1, 0.25), request(2, 0.25)],
    pathOffsets: [0, 1, 3],
    pointOffsets: [0, 2, 6],
    verbs: [0, 0, 1],
    points: [Number.NaN, 0, -2, 3, 4, 5],
  };
  return [
    {
      id: 'edge/zero-screen-transform',
      category: 'edge',
      input: cubicInput([base], [zeroTolerance.bucketTolerance]),
      metadata: {
        cubic: base,
        world: [0, 0, 0, 0],
        zoom: 1,
        dpr: 1,
        bucketTolerance: zeroTolerance.bucketTolerance,
      },
      expectedBatchStatus: BATCH_OK,
      paths: [cubicExpectation(base, [0, 0, 0, 0])],
    },
    {
      id: 'edge/rank-one-screen-transform',
      category: 'edge',
      input: cubicInput([base], [rankOneTolerance.bucketTolerance]),
      metadata: {
        cubic: base,
        world: [1, 2, 0, 0],
        zoom: 1,
        dpr: 1,
        bucketTolerance: rankOneTolerance.bucketTolerance,
      },
      expectedBatchStatus: BATCH_OK,
      paths: [cubicExpectation(base, [1, 2, 0, 0])],
    },
    ...bucketNeighbors.map(({ zoom, tolerance }, index): DifferentialCase => ({
      id: `edge/bucket-neighbor-${index}`,
      category: 'edge',
      input: cubicInput([base], [tolerance.bucketTolerance]),
      metadata: {
        cubic: base,
        world: identity,
        zoom,
        dpr: 1,
        bucketTolerance: tolerance.bucketTolerance,
      },
      expectedBatchStatus: BATCH_OK,
      paths: [cubicExpectation(base, tolerance.screen)],
    })),
    {
      id: 'edge/adjacent-cubics-unequal-depth',
      category: 'edge',
      input: adjacentInput,
      metadata: { first: adjacentCubics[0]?.cubic, second: adjacentCubics[1]?.cubic },
      expectedBatchStatus: BATCH_OK,
      paths: [{ status: 0, cubics: adjacentCubics, screen: identity }],
    },
    {
      id: 'edge/output-capacity-retry',
      category: 'edge',
      input: outputRetryInput,
      metadata: {
        sourceCorpusIndex: maximumLeafFixture.index,
        cubic: maximumLeafFixture.cubic,
        world: maximumLeafFixture.world,
        zoom: maximumLeafFixture.zoom,
        dpr: maximumLeafFixture.dpr,
        bucketTolerance: maximumLeafFixture.bucketTolerance,
        expectedLeafCountPerCubic: 8192,
      },
      expectedBatchStatus: BATCH_OK,
      paths: [
        {
          status: 0,
          cubics: extractCubics(outputRetryInput, 0),
          screen: screenFor(
            maximumLeafFixture.world,
            maximumLeafFixture.zoom,
            maximumLeafFixture.dpr,
          ),
        },
      ],
    },
    {
      id: 'edge/nonfinite-failure-valid-neighbor',
      category: 'edge',
      input: mixedNonfiniteInput,
      metadata: { purpose: 'per-path nonfinite isolation', expectedStatuses: [2, 0] },
      expectedBatchStatus: BATCH_OK,
      paths: [{ status: 2 }, { status: 0, cubics: [], screen: identity }],
    },
  ];
}

export function createDifferentialCases(): DifferentialCase[] {
  return [
    ...corpusCases(),
    ...namedCubicCases(),
    ...namedPackedCases(),
    ...metamorphicCases(),
    subdivisionCase(),
    ...edgeCases(),
  ];
}

export function encodeCase(testCase: DifferentialCase): Uint8Array<ArrayBuffer> {
  const input = testCase.input;
  const pathCount = input.requests.length;
  const requestsOffset = HEADER_BYTES;
  const pathOffsetsOffset = requestsOffset + pathCount * REQUEST_BYTES;
  const pointOffsetsOffset = pathOffsetsOffset + (pathCount + 1) * 4;
  const verbsOffset = pointOffsetsOffset + (pathCount + 1) * 4;
  const pointsOffset = align(verbsOffset + input.verbs.length, 8);
  const bytes = new Uint8Array(pointsOffset + input.points.length * 8);
  const view = new DataView(bytes.buffer);
  [
    INPUT_MAGIC,
    ABI_VERSION,
    bytes.length,
    pathCount,
    input.verbs.length,
    input.points.length,
    requestsOffset,
    pathOffsetsOffset,
    pointOffsetsOffset,
    verbsOffset,
    pointsOffset,
    0,
  ].forEach((value, index) => view.setUint32(index * 4, value, true));
  input.requests.forEach((value, index) => {
    const offset = requestsOffset + index * REQUEST_BYTES;
    view.setUint32(offset, value.requestId, true);
    view.setUint32(offset + 4, value.sourceEpoch, true);
    view.setUint32(offset + 8, value.sourceRevision, true);
    view.setFloat64(offset + 16, value.bucketTolerance, true);
  });
  Array.from(input.pathOffsets).forEach((value, index) =>
    view.setUint32(pathOffsetsOffset + index * 4, value, true),
  );
  Array.from(input.pointOffsets).forEach((value, index) =>
    view.setUint32(pointOffsetsOffset + index * 4, value, true),
  );
  bytes.set(Array.from(input.verbs), verbsOffset);
  Array.from(input.points).forEach((value, index) =>
    view.setFloat64(pointsOffset + index * 8, value, true),
  );
  return bytes;
}

export function verifyCase(
  testCase: DifferentialCase,
  batchStatus: number,
  output: Uint8Array,
): DifferentialVerificationSummary {
  const fail = (detail: string): never => {
    throw new DifferentialVerificationError(testCase, detail);
  };
  if (batchStatus !== testCase.expectedBatchStatus) {
    fail(`batch status ${batchStatus} != ${testCase.expectedBatchStatus}`);
  }
  if (batchStatus !== BATCH_OK) {
    if (output.byteLength !== 0) fail('failed batch published output bytes');
    return { id: testCase.id, pathCount: 0, successfulPaths: 0, emittedLines: 0 };
  }
  if (testCase.id === 'edge/output-capacity-retry' && output.byteLength <= 256 * 1024) {
    fail(`large retry fixture published only ${output.byteLength} bytes`);
  }
  let decoded: readonly DecodedPath[] = [];
  try {
    decoded = decodeOutput(output, testCase.input);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (decoded.length !== testCase.paths.length)
    fail('decoded path count differs from expectations');
  let successfulPaths = 0;
  let emittedLines = 0;
  decoded.forEach((result, pathIndex) => {
    const expected = testCase.paths[pathIndex];
    if (!expected) return fail(`missing path expectation ${pathIndex}`);
    if (result.status !== expected.status) {
      fail(`path ${pathIndex} status ${result.status} != ${expected.status}`);
    }
    if (result.status !== 0) return;
    successfulPaths += 1;
    emittedLines += result.verbs.filter((verb) => verb === 1).length;
    validateBounds(testCase, pathIndex, result, expected, fail);
    validateFlattenedStream(testCase, pathIndex, result, fail);
    validateCubics(pathIndex, result, expected, fail);
  });
  validateRelation(testCase, decoded, fail);
  return { id: testCase.id, pathCount: decoded.length, successfulPaths, emittedLines };
}

export function runPositiveControls(): PositiveControlSummary {
  let rejected = 0;
  for (const control of CONTINUOUS_ERROR_POSITIVE_CONTROLS) {
    const result = validateContinuousCubicError(control.cubic, control.lines, identity, 2);
    if (
      !result.ok &&
      result.findings.some((finding) => finding.includes(control.expectedFinding))
    ) {
      rejected += 1;
    }
  }
  const boundsCubic: Cubic = [
    [0, 0],
    [1, 2],
    [2, 2],
    [3, 0],
  ];
  const exact = referenceCubicBounds(boundsCubic);
  for (const candidate of [
    { ...exact, minX: exact.minX + 0.01 },
    { ...exact, minY: exact.minY + 0.01 },
    { ...exact, maxX: exact.maxX - 0.01 },
    { ...exact, maxY: exact.maxY - 0.01 },
  ]) {
    if (!validateReferenceBounds(boundsCubic, candidate).ok) rejected += 1;
  }
  const streamCubic: Cubic = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ];
  const verifierCase: DifferentialCase = {
    id: 'positive-control/flattened-stream',
    category: 'edge',
    input: cubicInput([streamCubic], [0.25]),
    metadata: { purpose: 'verifier positive controls', cubic: streamCubic },
    expectedBatchStatus: BATCH_OK,
    paths: [cubicExpectation(streamCubic)],
  };
  const valid = syntheticOutput(verifierCase.input, [
    {
      status: 0,
      bounds: referenceCubicBounds(streamCubic),
      verbs: [0, 1],
      points: [...streamCubic[0], ...streamCubic[3]],
      provenance: [0, 1, 0, 1, 1, 0],
    },
  ]);
  verifyCase(verifierCase, BATCH_OK, valid);
  const corruptions: Uint8Array[] = [];
  const movedStart = valid.slice();
  new DataView(movedStart.buffer).setFloat64(
    outputPointsOffset(movedStart),
    streamCubic[0][0] + 1,
    true,
  );
  corruptions.push(movedStart);
  const missingMove = valid.slice();
  missingMove[outputVerbsOffset(missingMove)] = 1;
  corruptions.push(missingMove);
  const wrongSource = valid.slice();
  new DataView(wrongSource.buffer).setUint32(outputProvenanceOffset(wrongSource) + 12, 0, true);
  corruptions.push(wrongSource);
  corruptions.push(
    syntheticOutput(verifierCase.input, [
      {
        status: 0,
        bounds: referenceCubicBounds(streamCubic),
        verbs: [0, 1, 1],
        points: [...streamCubic[0], ...streamCubic[3], ...streamCubic[3]],
        provenance: [0, 1, 0, 1, 1, 0, 1, 1, 0],
      },
    ]),
  );
  for (const corrupted of corruptions) {
    try {
      verifyCase(verifierCase, BATCH_OK, corrupted);
    } catch (error) {
      if (error instanceof DifferentialVerificationError) rejected += 1;
    }
  }
  const attempted = CONTINUOUS_ERROR_POSITIVE_CONTROLS.length + 4 + corruptions.length;
  if (rejected !== attempted)
    throw new Error(`positive controls rejected ${rejected}/${attempted}`);
  return { attempted, rejected };
}

function validateFlattenedStream(
  testCase: DifferentialCase,
  pathIndex: number,
  result: DecodedPath,
  fail: (detail: string) => never,
): void {
  const input = testCase.input;
  const sourceVerbStart = input.pathOffsets[pathIndex];
  const sourceVerbEnd = input.pathOffsets[pathIndex + 1];
  const sourcePointStart = input.pointOffsets[pathIndex];
  const sourcePointEnd = input.pointOffsets[pathIndex + 1];
  if (
    sourceVerbStart === undefined ||
    sourceVerbEnd === undefined ||
    sourcePointStart === undefined ||
    sourcePointEnd === undefined
  )
    fail(`path ${pathIndex} source ranges are absent`);
  let outputVerb = 0;
  let outputPoint = 0;
  let sourcePoint = sourcePointStart;
  const assertTriplet = (sourceOrdinal: number, numerator: number, depth: number) => {
    const offset = outputVerb * 3;
    if (
      result.provenance[offset] !== sourceOrdinal ||
      result.provenance[offset + 1] !== numerator ||
      result.provenance[offset + 2] !== depth
    )
      fail(`path ${pathIndex} output verb ${outputVerb} has invalid provenance`);
  };
  for (let sourceVerb = sourceVerbStart; sourceVerb < sourceVerbEnd; sourceVerb += 1) {
    const sourceOrdinal = sourceVerb - sourceVerbStart;
    const verb = input.verbs[sourceVerb];
    if (verb === 0 || verb === 1) {
      if (result.verbs[outputVerb] !== verb)
        fail(`path ${pathIndex} source verb ${sourceOrdinal} was not preserved`);
      assertTriplet(sourceOrdinal, 1, 0);
      if (
        !Object.is(result.points[outputPoint], input.points[sourcePoint]) ||
        !Object.is(result.points[outputPoint + 1], input.points[sourcePoint + 1])
      )
        fail(`path ${pathIndex} source verb ${sourceOrdinal} endpoint changed`);
      outputVerb += 1;
      outputPoint += 2;
      sourcePoint += 2;
    } else if (verb === 2) {
      let count = 0;
      while (
        outputVerb < result.verbs.length &&
        result.provenance[outputVerb * 3] === sourceOrdinal
      ) {
        if (result.verbs[outputVerb] !== 1)
          fail(`path ${pathIndex} cubic ${sourceOrdinal} emitted a non-LINE verb`);
        outputVerb += 1;
        outputPoint += 2;
        count += 1;
      }
      if (count === 0) fail(`path ${pathIndex} cubic ${sourceOrdinal} emitted no LINEs`);
      sourcePoint += 6;
    } else if (verb === 3) {
      if (result.verbs[outputVerb] !== 3)
        fail(`path ${pathIndex} CLOSE at ${sourceOrdinal} was not preserved`);
      assertTriplet(sourceOrdinal, 1, 0);
      outputVerb += 1;
    } else {
      fail(`path ${pathIndex} successful source contains unknown verb ${String(verb)}`);
    }
  }
  if (
    sourcePoint !== sourcePointEnd ||
    outputVerb !== result.verbs.length ||
    outputPoint !== result.points.length ||
    result.provenance.length !== result.verbs.length * 3
  )
    fail(`path ${pathIndex} flattened stream has unconsumed verbs, points, or provenance`);
}

function decodeOutput(bytes: Uint8Array, input: CanonicalPackedInput): DecodedPath[] {
  if (bytes.byteLength < HEADER_BYTES) throw new Error('output is shorter than its header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (u32(0) !== OUTPUT_MAGIC || u32(4) !== ABI_VERSION || u32(8) !== bytes.byteLength)
    throw new Error('output header identity or length is invalid');
  const pathCount = u32(12);
  const verbCount = u32(16);
  const pointCount = u32(20);
  const recordsOffset = u32(24);
  const verbsOffset = u32(28);
  const pointsOffset = u32(32);
  const provenanceOffset = u32(36);
  if (u32(40) !== 0 || u32(44) !== 0) throw new Error('output reserved fields are nonzero');
  if (pathCount !== input.requests.length) throw new Error('output path count differs from input');
  if (
    recordsOffset !== HEADER_BYTES ||
    verbsOffset !== recordsOffset + pathCount * RESULT_BYTES ||
    pointsOffset !== align(verbsOffset + verbCount, 8) ||
    provenanceOffset !== pointsOffset + pointCount * 8 ||
    provenanceOffset + verbCount * PROVENANCE_BYTES !== bytes.byteLength
  )
    throw new Error('output sections are not canonical');
  for (let offset = verbsOffset + verbCount; offset < pointsOffset; offset += 1) {
    if (view.getUint8(offset) !== 0) throw new Error('output alignment padding is nonzero');
  }
  let previousVerb = 0;
  let previousPoint = 0;
  const decoded: DecodedPath[] = [];
  for (let index = 0; index < pathCount; index += 1) {
    const offset = recordsOffset + index * RESULT_BYTES;
    const source = input.requests[index];
    if (
      !source ||
      u32(offset) !== source.requestId ||
      u32(offset + 4) !== source.sourceEpoch ||
      u32(offset + 8) !== source.sourceRevision
    )
      throw new Error(`path ${index} source echo differs from input`);
    const status = u32(offset + 12);
    const verbStart = u32(offset + 16);
    const verbEnd = u32(offset + 20);
    const pointStart = u32(offset + 24);
    const pointEnd = u32(offset + 28);
    if (
      verbStart !== previousVerb ||
      pointStart !== previousPoint ||
      verbEnd < verbStart ||
      pointEnd < pointStart ||
      verbEnd > verbCount ||
      pointEnd > pointCount
    )
      throw new Error(`path ${index} ranges are invalid`);
    const bounds = {
      minX: view.getFloat64(offset + 32, true),
      minY: view.getFloat64(offset + 40, true),
      maxX: view.getFloat64(offset + 48, true),
      maxY: view.getFloat64(offset + 56, true),
    };
    const verbs = Array.from({ length: verbEnd - verbStart }, (_, item) =>
      view.getUint8(verbsOffset + verbStart + item),
    );
    const points = Array.from({ length: pointEnd - pointStart }, (_, item) =>
      view.getFloat64(pointsOffset + (pointStart + item) * 8, true),
    );
    const provenance = Array.from({ length: verbs.length * 3 }, (_, item) =>
      u32(provenanceOffset + (verbStart * 3 + item) * 4),
    );
    if (status > 5) throw new Error(`path ${index} status is outside the declared range`);
    if (status !== 0 && (verbs.length !== 0 || points.length !== 0))
      throw new Error(`path ${index} failure publishes partial geometry`);
    if (status === 0 && ![...Object.values(bounds), ...points].every(Number.isFinite))
      throw new Error(`path ${index} success publishes nonfinite values`);
    if (status !== 0 && Object.values(bounds).some((value) => value !== 0))
      throw new Error(`path ${index} failure publishes nonzero bounds`);
    decoded.push({ status, bounds, verbs, points, provenance });
    previousVerb = verbEnd;
    previousPoint = pointEnd;
  }
  if (previousVerb !== verbCount || previousPoint !== pointCount)
    throw new Error('output ranges do not consume all published data');
  return decoded;
}

function validateBounds(
  testCase: DifferentialCase,
  pathIndex: number,
  result: DecodedPath,
  expected: PathExpectation,
  fail: (detail: string) => never,
) {
  const verbStart = testCase.input.pathOffsets[pathIndex];
  const verbEnd = testCase.input.pathOffsets[pathIndex + 1];
  const pointStart = testCase.input.pointOffsets[pathIndex];
  const pointEnd = testCase.input.pointOffsets[pathIndex + 1];
  const isCanonicalSingleCubic =
    verbStart !== undefined &&
    verbEnd === verbStart + 2 &&
    testCase.input.verbs[verbStart] === 0 &&
    testCase.input.verbs[verbStart + 1] === 2 &&
    pointStart !== undefined &&
    pointEnd === pointStart + 8;
  if (expected.cubics?.length === 1 && isCanonicalSingleCubic) {
    const checked = validateReferenceBounds(expected.cubics[0]!.cubic, result.bounds);
    if (!checked.ok) fail(`path ${pathIndex} bounds: ${checked.findings.join('; ')}`);
    return;
  }
  const reference = referencePackedPathBounds(testCase.input);
  if (!reference.ok) fail(`reference packed input failed: ${reference.findings.join('; ')}`);
  const candidate = reference.paths[pathIndex]?.bounds;
  if (!candidate) fail(`reference bounds missing for path ${pathIndex}`);
  if (pointStart === undefined || pointEnd === undefined)
    fail(`reference point range missing for path ${pathIndex}`);
  let scale = 1;
  for (let index = pointStart; index < pointEnd; index += 1) {
    const value = testCase.input.points[index];
    if (value !== undefined && Number.isFinite(value)) scale = Math.max(scale, Math.abs(value));
  }
  const tolerance = 1e-9 + 256 * Number.EPSILON * scale;
  for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) {
    const actual = result.bounds[key];
    const referenceValue = candidate[key];
    const minimum = key === 'minX' || key === 'minY';
    const contains = minimum
      ? actual <= referenceValue + tolerance
      : actual >= referenceValue - tolerance;
    const tight = minimum
      ? actual >= referenceValue - 2 * tolerance
      : actual <= referenceValue + 2 * tolerance;
    if (!contains) fail(`path ${pathIndex} ${key} understates the packed reference bound`);
    if (!tight) fail(`path ${pathIndex} ${key} is not tight within packed reference tolerance`);
  }
}

function validateCubics(
  pathIndex: number,
  result: DecodedPath,
  expected: PathExpectation,
  fail: (detail: string) => never,
) {
  for (const entry of expected.cubics ?? []) {
    const lines: ReferenceFlattenedLine[] = [];
    let pointIndex = 0;
    for (let verbIndex = 0; verbIndex < result.verbs.length; verbIndex += 1) {
      const verb = result.verbs[verbIndex];
      const source = result.provenance[verbIndex * 3];
      if (verb === 0 || verb === 1) {
        const end = result.points.slice(pointIndex, pointIndex + 2) as unknown as readonly [
          number,
          number,
        ];
        if (verb === 1 && source === entry.sourceVerbOrdinal) {
          lines.push({
            end,
            provenance: {
              sourceVerbOrdinal: source,
              endNumerator: result.provenance[verbIndex * 3 + 1]!,
              depth: result.provenance[verbIndex * 3 + 2]!,
            },
          });
        }
        pointIndex += 2;
      }
    }
    const checked = validateContinuousCubicError(
      entry.cubic,
      lines,
      expected.screen ?? identity,
      entry.sourceVerbOrdinal,
    );
    if (!checked.ok)
      fail(`path ${pathIndex} cubic ${entry.sourceVerbOrdinal}: ${checked.findings.join('; ')}`);
  }
}

function screenFor(world: Matrix2, zoom: number, dpr: number): Matrix2 {
  const checked = screenTolerance(world, zoom, dpr);
  if (!checked.ok) throw new Error(checked.finding);
  return checked.screen;
}

function outputVerbsOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28, true);
}

function outputPointsOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(32, true);
}

function outputProvenanceOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(36, true);
}

function syntheticOutput(input: CanonicalPackedInput, paths: readonly DecodedPath[]): Uint8Array {
  const verbCount = paths.reduce((sum, path) => sum + path.verbs.length, 0);
  const pointCount = paths.reduce((sum, path) => sum + path.points.length, 0);
  const recordsOffset = HEADER_BYTES;
  const verbsOffset = recordsOffset + paths.length * RESULT_BYTES;
  const pointsOffset = align(verbsOffset + verbCount, 8);
  const provenanceOffset = pointsOffset + pointCount * 8;
  const bytes = new Uint8Array(provenanceOffset + verbCount * PROVENANCE_BYTES);
  const view = new DataView(bytes.buffer);
  [
    OUTPUT_MAGIC,
    ABI_VERSION,
    bytes.length,
    paths.length,
    verbCount,
    pointCount,
    recordsOffset,
    verbsOffset,
    pointsOffset,
    provenanceOffset,
    0,
    0,
  ].forEach((value, index) => view.setUint32(index * 4, value, true));
  let verbCursor = 0;
  let pointCursor = 0;
  paths.forEach((path, pathIndex) => {
    const source = input.requests[pathIndex];
    if (!source) throw new Error('synthetic output request is absent');
    const offset = recordsOffset + pathIndex * RESULT_BYTES;
    view.setUint32(offset, source.requestId, true);
    view.setUint32(offset + 4, source.sourceEpoch, true);
    view.setUint32(offset + 8, source.sourceRevision, true);
    view.setUint32(offset + 12, path.status, true);
    view.setUint32(offset + 16, verbCursor, true);
    view.setUint32(offset + 20, verbCursor + path.verbs.length, true);
    view.setUint32(offset + 24, pointCursor, true);
    view.setUint32(offset + 28, pointCursor + path.points.length, true);
    view.setFloat64(offset + 32, path.bounds.minX, true);
    view.setFloat64(offset + 40, path.bounds.minY, true);
    view.setFloat64(offset + 48, path.bounds.maxX, true);
    view.setFloat64(offset + 56, path.bounds.maxY, true);
    path.verbs.forEach((verb, index) => (bytes[verbsOffset + verbCursor + index] = verb));
    path.points.forEach((point, index) =>
      view.setFloat64(pointsOffset + (pointCursor + index) * 8, point, true),
    );
    path.provenance.forEach((value, index) =>
      view.setUint32(provenanceOffset + (verbCursor * 3 + index) * 4, value, true),
    );
    verbCursor += path.verbs.length;
    pointCursor += path.points.length;
  });
  return bytes;
}

function validateRelation(
  testCase: DifferentialCase,
  paths: readonly DecodedPath[],
  fail: (detail: string) => never,
) {
  if (!testCase.relation) return;
  const source = paths[0]?.bounds;
  const transformed = paths[1]?.bounds;
  if (!source || !transformed) fail('metamorphic relation lacks successful path bounds');
  const close = (actual: number, expected: number) =>
    Math.abs(actual - expected) <= 1e-8 + 512 * Number.EPSILON * Math.max(1, Math.abs(expected));
  if (testCase.relation === 'reverse') {
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const)
      if (!close(transformed[key], source[key])) fail(`reversal changed ${key}`);
  } else if (testCase.relation === 'translate') {
    if (
      !close(transformed.minX, source.minX + 1e6) ||
      !close(transformed.maxX, source.maxX + 1e6) ||
      !close(transformed.minY, source.minY - 1e6) ||
      !close(transformed.maxY, source.maxY - 1e6)
    )
      fail('translation bounds relation failed');
  } else if (testCase.relation === 'uniform-scale') {
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const)
      if (!close(transformed[key], source[key] * 8))
        fail(`uniform scale changed ${key} incorrectly`);
  } else {
    const right = paths[2]?.bounds;
    if (!right) fail('subdivision relation lacks right-half bounds');
    const union = {
      minX: Math.min(transformed.minX, right.minX),
      minY: Math.min(transformed.minY, right.minY),
      maxX: Math.max(transformed.maxX, right.maxX),
      maxY: Math.max(transformed.maxY, right.maxY),
    };
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const)
      if (!close(union[key], source[key])) fail(`subdivision union changed ${key}`);
  }
}

function extractCubics(input: CanonicalPackedInput, pathIndex: number) {
  const entries: { cubic: Cubic; sourceVerbOrdinal: number }[] = [];
  let pointIndex = input.pointOffsets[pathIndex] ?? 0;
  let current: readonly [number, number] | undefined;
  for (
    let verbIndex = input.pathOffsets[pathIndex] ?? 0;
    verbIndex < (input.pathOffsets[pathIndex + 1] ?? 0);
    verbIndex += 1
  ) {
    const verb = input.verbs[verbIndex];
    if (verb === 0 || verb === 1) {
      current = [input.points[pointIndex]!, input.points[pointIndex + 1]!];
      pointIndex += 2;
    } else if (verb === 2 && current) {
      const cubic: Cubic = [
        current,
        [input.points[pointIndex]!, input.points[pointIndex + 1]!],
        [input.points[pointIndex + 2]!, input.points[pointIndex + 3]!],
        [input.points[pointIndex + 4]!, input.points[pointIndex + 5]!],
      ];
      entries.push({ cubic, sourceVerbOrdinal: verbIndex - (input.pathOffsets[pathIndex] ?? 0) });
      current = cubic[3];
      pointIndex += 6;
    }
  }
  return entries;
}

function stringifyMetadata(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'number' && !Number.isFinite(entry)) return String(entry);
    return entry;
  });
}
