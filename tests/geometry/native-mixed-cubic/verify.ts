import assert from 'node:assert/strict';
import type {
  Point,
  ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/types.js';
import { inspectTriangleMesh } from '../../../packages/geometry-reference/src/triangle-mesh.js';
import { certifyCubicBoundary } from '../cubic-boundary/oracle.js';
import type { NativeCubicCommand } from '../native-cubic/native.js';
import type { NativeCubicSourceFixtureRow } from '../native-cubic/fixtures.js';
import {
  assertFlatBounds,
  decodeActualSegments,
  roundedFixture,
  type ActualSegment,
} from '../native-cubic/verify.js';
import { bitsOf } from '../rounded-fill/exact.js';
import {
  assertCarrierMatches,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from '../rounded-fill/oracle.js';
import {
  certifyMixedTransverseCubicArrangement,
  certifyTransverseCubicArrangement,
} from '../simple-cubic-topology/oracle.js';
import type { CubicTopologySegmentFixture } from '../simple-cubic-topology/fixtures.js';
import type { NativeMixedCubicFixtureRow } from './fixtures.js';
import type { NativeMixedCubicEdgeOwner, NativeMixedCubicRow } from './native.js';

type MixedSourceFixture = Pick<
  NativeMixedCubicFixtureRow,
  'contours' | 'sourceKinds' | 'packedKinds'
>;

const FLATTEN_BITS = bitsOf(1 / 8)
  .toString(16)
  .padStart(16, '0');
const TOPOLOGY_BITS = bitsOf(1 / 16)
  .toString(16)
  .padStart(16, '0');

function pointBits([x, y]: Point): readonly [bigint, bigint] {
  return [bitsOf(x), bitsOf(y)];
}

export function polygonBits(polygons: readonly (readonly Point[])[]): string {
  return JSON.stringify(
    polygons.map((polygon) =>
      polygon.map((point) => pointBits(point).map((bits) => bits.toString(16))),
    ),
  );
}

export function packedSegments(fixture: MixedSourceFixture): {
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  kinds: readonly boolean[];
} {
  let sourceIndex = 0;
  const kinds: boolean[] = [];
  const contours = fixture.contours.map((contour) => {
    const segments: CubicTopologySegmentFixture[] = [];
    contour.cubics.forEach((cubic, contourSourceIndex) => {
      const kind = fixture.sourceKinds[sourceIndex]!;
      const sourceVerbOrdinal = contour.cubicVerbOrdinals[contourSourceIndex]!;
      sourceIndex += 1;
      if (kind && cubic[0][0] === cubic[3][0] && cubic[0][1] === cubic[3][1]) return;
      segments.push({
        cubic,
        sourceVerbOrdinal,
        lines: [
          {
            end: cubic[3],
            provenance: { sourceVerbOrdinal, endNumerator: 1, depth: 0 },
          },
        ],
      });
      kinds.push(kind);
    });
    return segments;
  });
  assert.deepEqual(kinds, fixture.packedKinds);
  return { contours, kinds };
}

type ActualMixedSourceFixture = MixedSourceFixture & NativeCubicSourceFixtureRow;
type ExpectedLeafPartitions = readonly (readonly (readonly ReferenceFlattenedLine[])[])[];

function samePoint(left: Point, right: Point): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

export function actualPackedMixedSegments(
  fixture: ActualMixedSourceFixture,
  commands: readonly NativeCubicCommand[],
  expectedPartitions: ExpectedLeafPartitions,
): {
  contours: readonly (readonly ActualSegment[])[];
  kinds: readonly boolean[];
} {
  const decoded = decodeActualSegments(fixture, commands);
  assert.equal(expectedPartitions.length, decoded.length, 'leaf partition contour count');
  let sourceIndex = 0;
  const kinds: boolean[] = [];
  const contours = decoded.map((contour, contourIndex) => {
    const expectedContour = expectedPartitions[contourIndex];
    assert.equal(
      expectedContour?.length,
      contour.length,
      `contour ${contourIndex} partition count`,
    );
    const packed: ActualSegment[] = [];
    contour.forEach((segment, contourSourceIndex) => {
      const kind = fixture.sourceKinds[sourceIndex++];
      if (kind === undefined) throw new Error('source kind missing');
      const expectedLines = expectedContour[contourSourceIndex]!;
      assert.equal(segment.lines.length, expectedLines.length, 'source leaf count mismatch');
      segment.lines.forEach((line, lineIndex) => {
        const expected = expectedLines[lineIndex]!;
        assert.deepEqual(pointBits(line.end), pointBits(expected.end), 'source leaf endpoint bits');
        assert.deepEqual(line.provenance, expected.provenance, 'source leaf provenance');
      });
      if (kind) {
        assert.equal(segment.lines.length, 1, 'marked LINE leaf count');
        assert.deepEqual(pointBits(segment.cubic[0]), pointBits(segment.cubic[1]));
        assert.deepEqual(pointBits(segment.cubic[2]), pointBits(segment.cubic[3]));
        assert.deepEqual(segment.lines[0]!.provenance, {
          sourceVerbOrdinal: segment.sourceVerbOrdinal,
          endNumerator: 1,
          depth: 0,
        });
        assert.deepEqual(pointBits(segment.lines[0]!.end), pointBits(segment.cubic[3]));
        if (samePoint(segment.cubic[0], segment.cubic[3])) return;
      } else {
        const boundary = certifyCubicBoundary({
          cubic: segment.cubic,
          lines: segment.lines,
          screen: [1, 0, 0, 1],
          sourceVerbOrdinal: segment.sourceVerbOrdinal,
        });
        if (!boundary.ok)
          throw new Error(`source cubic ${segment.sourceVerbOrdinal} boundary ${boundary.status}`);
      }
      packed.push(segment);
      kinds.push(kind);
    });
    return packed;
  });
  assert.equal(sourceIndex, fixture.sourceKinds.length, 'unconsumed source kinds');
  assert.deepEqual(kinds, fixture.packedKinds);
  return { contours, kinds };
}

export function expectedOwners(
  fixture: MixedSourceFixture,
  packed: ReturnType<typeof packedSegments>,
): readonly NativeMixedCubicEdgeOwner[] {
  const owners: NativeMixedCubicEdgeOwner[] = [];
  let packedIndex = 0;
  packed.contours.forEach((contour, contourIndex) => {
    for (const segment of contour) {
      if (packed.kinds[packedIndex]!) {
        owners.push({ kind: 'Line', source_verb: segment.sourceVerbOrdinal });
      } else {
        for (const line of segment.lines)
          owners.push({
            kind: 'CubicLeaf',
            source_verb: segment.sourceVerbOrdinal,
            end_numerator: line.provenance.endNumerator,
            depth: line.provenance.depth,
          });
      }
      packedIndex += 1;
    }
    if (fixture.contours[contourIndex]!.closeVerbOrdinal === null)
      owners.push({ kind: 'ImplicitClosure', contour: contourIndex });
  });
  return owners;
}

function expectedCommands(fixture: Pick<MixedSourceFixture, 'contours'>) {
  return fixture.contours.flatMap((contour) => {
    const commands: NativeCubicCommand[] = [
      {
        verb: 0 as const,
        point: contour.cubics[0]![0],
        provenance: { source_verb: contour.moveVerbOrdinal, end_numerator: 1, depth: 0 },
      },
      ...contour.cubics.map((cubic, index) => ({
        verb: 1 as const,
        point: cubic[3],
        provenance: {
          source_verb: contour.cubicVerbOrdinals[index]!,
          end_numerator: 1,
          depth: 0,
        },
      })),
    ];
    if (contour.closeVerbOrdinal !== null)
      commands.push({
        verb: 3 as const,
        point: null,
        provenance: { source_verb: contour.closeVerbOrdinal, end_numerator: 1, depth: 0 },
      });
    return commands;
  });
}

export function assertCommandIdentity(
  fixture: Pick<MixedSourceFixture, 'contours'>,
  actual: NativeMixedCubicRow,
) {
  const commands = actual.carrier.commands;
  if (!commands) throw new Error('mixed cubic commands missing');
  const expected = expectedCommands(fixture);
  assert.equal(commands.length, expected.length);
  commands.forEach((command, index) => {
    const wanted = expected[index]!;
    assert.equal(command.verb, wanted.verb, `command ${index} verb`);
    assert.deepEqual(command.provenance, wanted.provenance, `command ${index} provenance`);
    if (wanted.point === null) assert.equal(command.point, null, `command ${index} point`);
    else if (command.point === null) throw new Error(`command ${index} point missing`);
    else
      assert.deepEqual(pointBits(command.point), pointBits(wanted.point), `command ${index} bits`);
  });
}

export function assertSourcePositionProof(
  fixture: Pick<MixedSourceFixture, 'contours' | 'sourceKinds'>,
): void {
  let sourceIndex = 0;
  fixture.contours.forEach((contour) =>
    contour.cubics.forEach((cubic, contourSourceIndex) => {
      const sourceVerbOrdinal = contour.cubicVerbOrdinals[contourSourceIndex]!;
      const kind = fixture.sourceKinds[sourceIndex++]!;
      const line: ReferenceFlattenedLine = {
        end: cubic[3],
        provenance: { sourceVerbOrdinal, endNumerator: 1, depth: 0 },
      };
      if (kind) {
        assert.deepEqual(pointBits(cubic[0]), pointBits(cubic[1]));
        assert.deepEqual(pointBits(cubic[2]), pointBits(cubic[3]));
      } else {
        const proof = certifyCubicBoundary({
          cubic,
          lines: [line],
          screen: [1, 0, 0, 1],
          sourceVerbOrdinal,
        });
        assert.equal(proof.status, 'CERTIFIED');
      }
    }),
  );
}

function assertCrossingOwners(
  fixture: NativeMixedCubicFixtureRow,
  actual: NativeMixedCubicRow,
  owners: readonly NativeMixedCubicEdgeOwner[],
): void {
  const output = actual.carrier.rounded?.output;
  if (!output) throw new Error('mixed cubic rounded output missing');
  const [x, y] = fixture.expectedCrossingPoint;
  const nodes = output.nodes.flatMap((node, index) =>
    node.point[0] === x && node.point[1] === y ? [index] : [],
  );
  if (nodes.length === 0) throw new Error('mixed cubic crossing node missing');
  const incident = new Set(
    output.sections.filter(({ node }) => nodes.includes(node)).map(({ edge }) => edge),
  );
  for (const span of output.spans) {
    if (!nodes.includes(span.lower) && !nodes.includes(span.upper)) continue;
    for (const edge of output.contributors.slice(
      span.vertical_sources.start,
      span.vertical_sources.start + span.vertical_sources.count,
    ))
      incident.add(edge);
  }
  const crossing = fixture.expectedCrossings[0]!;
  if (!incident.has(crossing.leftLeaf) || !incident.has(crossing.rightLeaf))
    throw new Error('mixed cubic crossing lost participating owners');
  if (!owners[crossing.leftLeaf] || !owners[crossing.rightLeaf])
    throw new Error('mixed cubic crossing owner missing');
}

export function assertNativeMixedCubicCarrier(
  fixture: NativeMixedCubicFixtureRow,
  actual: NativeMixedCubicRow,
): void {
  const row = actual.carrier;
  assert.equal(row.id, fixture.id);
  assert.equal(row.rule, fixture.rule);
  assert.deepEqual(row.source_bits, fixture.sourceBits);
  assert.deepEqual(actual.source_kinds, fixture.sourceKinds);
  assert.deepEqual(actual.topology, {
    topology_invoked: true,
    rounded_topology_invoked: false,
    rounded_topology_selected: false,
    rounded_topology_error: null,
    transverse_topology_invoked: true,
    transverse_topology_selected: true,
    transverse_topology_error: null,
    stats: { leaves: 8, pairs: 28 },
  });
  assert.equal(row.flatten_tolerance_bits, FLATTEN_BITS);
  assert.equal(row.topology_tolerance_bits, TOPOLOGY_BITS);
  assert.equal(row.flat_status, 0);
  assert.equal(row.allocations, 0);
  assert.equal(row.allocated_bytes, 1_111_552);
  assert.equal(row.inline_bytes, 12_952);
  if (!row.emission_plan || !row.commands || !row.edge_owners || !row.rounded?.output)
    throw new Error('mixed cubic carrier incomplete');
  assert.equal(row.commands.length, fixture.expectedCommandCount);
  assert.deepEqual(row.sizing_plan, {
    status: 0,
    verb_count: fixture.expectedCommandCount,
    point_count: 18,
  });
  assert.deepEqual(row.emission_plan, row.sizing_plan);
  assert.deepEqual(row.statistics, {
    logical_cubics: fixture.expectedCubicCount,
    sizing_visits: fixture.expectedCubicCount,
    emission_visits: fixture.expectedCubicCount,
    emitted_cubic_lines: fixture.expectedCubicCount,
  });
  // P2 depth-0 guard on both horizontal cubics: max original 9/2, relative 6.
  const boundsGuard = 128 * Number.EPSILON * (9 / 2 + 6);
  assert.deepEqual(row.flat_bounds, [
    -3 - boundsGuard,
    -9 / 2 - boundsGuard,
    3 + boundsGuard,
    9 / 2 + boundsGuard,
  ]);
  assertFlatBounds(row);
  assertCommandIdentity(fixture, actual);
  assertSourcePositionProof(fixture);

  const packed = packedSegments(fixture);
  const mixed = certifyMixedTransverseCubicArrangement(packed.contours, packed.kinds);
  assert.equal(mixed.status, 'CERTIFIED');
  assert.equal(mixed.leaves, 8);
  assert.equal(mixed.pairs, 28);
  assert.equal(polygonBits(mixed.certificate!.polygons), polygonBits([fixture.expectedPolygon]));
  assert.deepEqual(mixed.certificate!.crossings, fixture.expectedCrossings);
  const old = certifyTransverseCubicArrangement(packed.contours);
  assert.equal(old.status, 'UNRESOLVED');
  assert.equal(old.leaves, 8);
  assert.equal(old.pairs, fixture.expectedOldPairs);

  const owners = expectedOwners(fixture, packed);
  assert.deepEqual(row.edge_owners, owners);
  assert.equal(owners.length, 8);
  const expectedSourceEdges = fixture.expectedPolygon.map((_, vertex) => ({
    contour: 0,
    start_vertex: vertex,
    end_vertex: (vertex + 1) % fixture.expectedPolygon.length,
  }));
  assert.deepEqual(row.rounded.output.source_edges, expectedSourceEdges);
  if (row.rounded.output.contributors.some((ownerIndex) => owners[ownerIndex] === undefined))
    throw new Error('mixed cubic contributor lost owner attribution');
  assertCrossingOwners(fixture, actual, owners);
  assert.equal(polygonBits(row.rounded.contours), polygonBits([fixture.expectedPolygon]));

  const roundedInput = roundedFixture(row);
  assert.equal(row.rounded.tau_bits, TOPOLOGY_BITS);
  assert.equal(row.rounded.profile, 'I');
  const oracle = buildRoundedFillOracle(roundedInput);
  if (!oracle.ok) throw new Error(`${fixture.id}:${fixture.rule} oracle failed: ${oracle.reason}`);
  assert.equal(oracle.properCrossings, 1);
  verifyRoundedFillCarrier(roundedInput, oracle, row.rounded.output);
  assertCarrierMatches(oracle.carrier, row.rounded.output);
  assert.deepEqual(
    inspectTriangleMesh({ ...row.rounded.output, expectedArea: fixture.expectedArea }),
    { valid: true, issue: null },
  );
  assert.deepEqual(row.rounded.stats, {
    input_vertices: 8,
    edges: 8,
    pair_checks: 28,
    events: oracle.rawEvents,
    columns: row.rounded.output.columns.length,
    sections: row.rounded.output.sections.length,
    nodes: row.rounded.output.nodes.length,
    cells: row.rounded.output.cells.length,
    boundaries: row.rounded.output.boundaries.length,
    contributors: row.rounded.output.contributors.length,
    work_units: row.rounded.stats.work_units,
  });
  assert.ok(row.rounded.stats.events <= 128);
  assert.ok(row.rounded.stats.columns <= 36);
  assert.ok(row.rounded.stats.sections <= 8320);
  assert.ok(row.rounded.stats.nodes <= 256);
  assert.ok(row.rounded.stats.cells <= 256);
  assert.ok(row.rounded.stats.boundaries <= 512);
  assert.ok(row.rounded.stats.contributors <= 512);
  assert.ok(row.rounded.stats.work_units <= 2_000_000);
  assert.ok(row.rounded.output.vertices.length <= 256);
  assert.ok(row.rounded.output.indices.length / 3 <= 256);
}
