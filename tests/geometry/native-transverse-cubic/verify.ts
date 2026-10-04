import assert from 'node:assert/strict';
import type { Point } from '../../../packages/geometry-reference/src/types.js';
import { inspectTriangleMesh } from '../../../packages/geometry-reference/src/triangle-mesh.js';
import type { NativeCubicRow } from '../native-cubic/native.js';
import {
  actualSegments,
  assertFixtureIdentity,
  assertFlatBounds,
  assertOwnerMapping,
  collectedContours,
  expectedOwners,
  roundedFixture,
} from '../native-cubic/verify.js';
import { bitsOf } from '../rounded-fill/exact.js';
import {
  assertCarrierMatches,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from '../rounded-fill/oracle.js';
import {
  certifyRoundedKnotCubicTopology,
  certifySimpleCubicTopology,
  certifyTransverseCubicArrangement,
} from '../simple-cubic-topology/oracle.js';
import type { NativeTransverseCubicFixtureRow } from './fixtures.js';
import type { NativeTransverseCubicRow } from './native.js';

const FLATTEN_BITS = bitsOf(1 / 8)
  .toString(16)
  .padStart(16, '0');
const TOPOLOGY_BITS = bitsOf(1 / 16)
  .toString(16)
  .padStart(16, '0');

function pointBitStrings(points: readonly Point[]): readonly (readonly string[])[] {
  return points.map(([x, y]) => [bitsOf(x).toString(16), bitsOf(y).toString(16)]);
}

export function polygonBitStrings(polygons: readonly (readonly Point[])[]): string {
  return JSON.stringify(polygons.map(pointBitStrings));
}

export function assertLiteralPolygons(
  fixture: NativeTransverseCubicFixtureRow,
  row: NativeCubicRow,
): void {
  if (!row.rounded) throw new Error('rounded source polygons missing');
  if (polygonBitStrings(row.rounded.contours) !== polygonBitStrings(fixture.expectedPolygons))
    throw new Error('rounded source polygon bits mismatch');
}

export function assertCrossingOwnerProvenance(
  fixture: NativeTransverseCubicFixtureRow,
  row: NativeCubicRow,
): void {
  if (!row.commands || !row.rounded?.output || !row.edge_owners)
    throw new Error('crossing owner carrier missing');
  const segments = actualSegments(fixture, row.commands);
  const owners = expectedOwners(fixture, segments);
  const output = row.rounded.output;
  fixture.expectedCrossings.forEach((crossing, crossingIndex) => {
    const point = fixture.expectedCrossingNodes[crossingIndex];
    if (!point) throw new Error('expected crossing point missing');
    const [x, y] = point;
    const nodeIndices = output.nodes.flatMap((node, index) =>
      node.point[0] === x && node.point[1] === y ? [index] : [],
    );
    if (nodeIndices.length === 0) throw new Error('expected crossing node missing');
    const incidentEdges = new Set(
      output.sections.filter(({ node }) => nodeIndices.includes(node)).map(({ edge }) => edge),
    );
    for (const span of output.spans) {
      if (!nodeIndices.includes(span.lower) && !nodeIndices.includes(span.upper)) continue;
      for (const edge of output.contributors.slice(
        span.vertical_sources.start,
        span.vertical_sources.start + span.vertical_sources.count,
      ))
        incidentEdges.add(edge);
    }
    if (!incidentEdges.has(crossing.leftLeaf) || !incidentEdges.has(crossing.rightLeaf))
      throw new Error('crossing node lost participating owners');
    if (owners[crossing.leftLeaf] === undefined || owners[crossing.rightLeaf] === undefined)
      throw new Error('crossing owner identity missing');
  });
}

export function assertNativeTransverseCubicCarrier(
  fixture: NativeTransverseCubicFixtureRow,
  actual: NativeTransverseCubicRow,
): void {
  const row = actual.carrier;
  assertFixtureIdentity(fixture, row);
  assert.deepEqual(actual.topology, {
    topology_invoked: true,
    rounded_topology_invoked: false,
    rounded_topology_selected: false,
    rounded_topology_error: null,
    transverse_topology_invoked: true,
    transverse_topology_selected: true,
    transverse_topology_error: null,
    stats: fixture.expectedTopology,
  });
  assert.equal(row.flat_status, 0);
  assert.equal(row.flatten_tolerance_bits, FLATTEN_BITS);
  assert.equal(row.topology_tolerance_bits, TOPOLOGY_BITS);
  assert.equal(row.allocations, 0);
  assert.ok(row.inline_bytes > 0 && row.inline_bytes < 64 * 1024);
  assert.ok(row.allocated_bytes > 0 && row.allocated_bytes <= 16 * 1024 * 1024);
  if (!row.commands || !row.emission_plan || !row.rounded?.output)
    throw new Error('transverse cubic carrier is incomplete');

  const sourceCount = fixture.contours.reduce((sum, contour) => sum + contour.cubics.length, 0);
  const emittedLineCount = fixture.expectedLeafPartitions.reduce(
    (rowTotal, contour) => rowTotal + contour.reduce((sum, leaves) => sum + leaves, 0),
    0,
  );
  assert.equal(row.commands.length, fixture.expectedCommandCount);
  assert.deepEqual(row.sizing_plan, {
    status: 0,
    verb_count: fixture.expectedCommandCount,
    point_count: (fixture.contours.length + emittedLineCount) * 2,
  });
  assert.deepEqual(row.emission_plan, row.sizing_plan);
  assert.deepEqual(row.statistics, {
    logical_cubics: sourceCount,
    sizing_visits: fixture.expectedVisits,
    emission_visits: fixture.expectedVisits,
    emitted_cubic_lines: emittedLineCount,
  });
  assertFlatBounds(row);

  const segments = actualSegments(fixture, row.commands);
  const actualPartitions = segments.map((contour) =>
    contour.map((segment) => segment.lines.length),
  );
  assert.deepEqual(actualPartitions, fixture.expectedLeafPartitions);
  const lines = segments.flatMap((contour) => contour.flatMap((segment) => segment.lines));
  assert.equal(lines.length, emittedLineCount);
  segments.forEach((contour, contourIndex) =>
    contour.forEach((segment, sourceIndex) => {
      const leafCount = fixture.expectedLeafPartitions[contourIndex]?.[sourceIndex];
      if (leafCount === 1) {
        assert.deepEqual(
          segment.lines.map(({ provenance }) => provenance),
          [{ sourceVerbOrdinal: segment.sourceVerbOrdinal, endNumerator: 1, depth: 0 }],
        );
      } else if (leafCount === 2) {
        assert.deepEqual(
          segment.lines.map(({ provenance }) => provenance),
          [
            { sourceVerbOrdinal: segment.sourceVerbOrdinal, endNumerator: 1, depth: 1 },
            { sourceVerbOrdinal: segment.sourceVerbOrdinal, endNumerator: 2, depth: 1 },
          ],
        );
      } else {
        throw new Error('unsupported frozen leaf partition');
      }
    }),
  );
  const points = collectedContours(segments);
  assert.equal(polygonBitStrings(points), polygonBitStrings(fixture.expectedPolygons));
  assertLiteralPolygons(fixture, row);

  assert.equal(certifySimpleCubicTopology(segments).status, 'UNRESOLVED');
  assert.equal(certifyRoundedKnotCubicTopology(segments).status, 'UNRESOLVED');
  const arrangement = certifyTransverseCubicArrangement(segments);
  assert.equal(arrangement.status, 'CERTIFIED');
  assert.equal(arrangement.leaves, fixture.expectedTopology.leaves);
  assert.equal(arrangement.pairs, fixture.expectedTopology.pairs);
  assert.equal(
    polygonBitStrings(arrangement.certificate!.polygons),
    polygonBitStrings(fixture.expectedPolygons),
  );
  assert.deepEqual(arrangement.certificate!.crossings, fixture.expectedCrossings);

  const owners = expectedOwners(fixture, segments);
  assert.equal(owners.length, fixture.expectedTopology.leaves);
  let ownerIndex = 0;
  fixture.contours.forEach((contour, contourIndex) => {
    for (const leafCount of fixture.expectedLeafPartitions[contourIndex]!) {
      for (let leafIndex = 0; leafIndex < leafCount; leafIndex += 1) {
        assert.equal(owners[ownerIndex]?.kind, 'CubicLeaf');
        ownerIndex += 1;
      }
    }
    if (contour.closeVerbOrdinal === null) {
      assert.deepEqual(owners[ownerIndex], { kind: 'ImplicitClosure', contour: contourIndex });
      ownerIndex += 1;
    }
  });
  assert.equal(ownerIndex, owners.length);
  assertOwnerMapping(owners, points, row);
  assertCrossingOwnerProvenance(fixture, row);

  const roundedInput = roundedFixture(row);
  assert.equal(row.rounded.tau_bits, TOPOLOGY_BITS);
  assert.equal(row.rounded.profile, 'I');
  const oracle = buildRoundedFillOracle(roundedInput);
  if (!oracle.ok) throw new Error(`${fixture.id}:${fixture.rule} oracle failed: ${oracle.reason}`);
  assert.equal(oracle.properCrossings, fixture.expectedCrossings.length);
  verifyRoundedFillCarrier(roundedInput, oracle, row.rounded.output);
  assertCarrierMatches(oracle.carrier, row.rounded.output);
  assert.deepEqual(
    inspectTriangleMesh({ ...row.rounded.output, expectedArea: fixture.expectedArea }),
    {
      valid: true,
      issue: null,
    },
  );
  assert.deepEqual(row.rounded.stats, {
    input_vertices: fixture.expectedTopology.leaves,
    edges: fixture.expectedTopology.leaves,
    pair_checks: fixture.expectedTopology.pairs,
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
