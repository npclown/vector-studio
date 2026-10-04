import assert from 'node:assert/strict';
import { inspectTriangleMesh } from '../../../packages/geometry-reference/src/triangle-mesh.js';
import { assertFlatBounds, roundedFixture } from '../native-cubic/verify.js';
import {
  assertCommandIdentity,
  assertSourcePositionProof,
  expectedOwners,
  packedSegments,
  polygonBits,
} from '../native-mixed-cubic/verify.js';
import type {
  NativeMixedCubicEdgeOwner,
  NativeMixedCubicRow,
} from '../native-mixed-cubic/native.js';
import { bitsOf, compare, exactInteger, rational } from '../rounded-fill/exact.js';
import {
  assertCarrierMatches,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from '../rounded-fill/oracle.js';
import {
  certifyMixedTransverseCubicArrangement,
  certifyTransverseCubicArrangement,
  certifyTriangleFreeCubicArrangement,
} from '../simple-cubic-topology/oracle.js';
import type { NativeTriangleFreeCubicFixtureRow } from './fixtures.js';

const FLATTEN_BITS = bitsOf(1 / 8)
  .toString(16)
  .padStart(16, '0');
const TOPOLOGY_BITS = bitsOf(1 / 16)
  .toString(16)
  .padStart(16, '0');
const BINARY64_UNIT = 1n << 1074n;
const EXPECTED_MESH_TWICE_AREA = 963n * (1n << 2144n) - (1n << 2100n);

type MeshData = Readonly<{
  vertices: readonly (readonly [number, number])[];
  indices: readonly number[];
}>;

export function exactMeshTwiceArea(mesh: MeshData): bigint {
  let total = 0n;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.vertices[mesh.indices[offset]!]!;
    const b = mesh.vertices[mesh.indices[offset + 1]!]!;
    const c = mesh.vertices[mesh.indices[offset + 2]!]!;
    const ax = exactInteger(bitsOf(a[0]));
    const ay = exactInteger(bitsOf(a[1]));
    const bx = exactInteger(bitsOf(b[0]));
    const by = exactInteger(bitsOf(b[1]));
    const cx = exactInteger(bitsOf(c[0]));
    const cy = exactInteger(bitsOf(c[1]));
    total += (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }
  return total;
}

export function assertExactMeshTwiceArea(mesh: MeshData, expected: bigint): void {
  assert.equal(exactMeshTwiceArea(mesh), expected);
}

function expectedSourceEdges(polygons: NativeTriangleFreeCubicFixtureRow['expectedPolygons']) {
  return polygons.flatMap((polygon, contour) =>
    polygon.map((_, startVertex) => ({
      contour,
      start_vertex: startVertex,
      end_vertex: (startVertex + 1) % polygon.length,
    })),
  );
}

function incidentOwners(
  actual: NativeMixedCubicRow,
  point: readonly [number, number],
): Set<number> {
  const output = actual.carrier.rounded?.output;
  if (!output) throw new Error('triangle-free rounded output missing');
  const nodes = output.nodes.flatMap((node, index) =>
    bitsOf(node.point[0]) === bitsOf(point[0]) && bitsOf(node.point[1]) === bitsOf(point[1])
      ? [index]
      : [],
  );
  if (nodes.length === 0) throw new Error('triangle-free crossing node missing');
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
  return incident;
}

function assertCrossingOwners(
  fixture: NativeTriangleFreeCubicFixtureRow,
  actual: NativeMixedCubicRow,
  owners: readonly NativeMixedCubicEdgeOwner[],
): void {
  fixture.expectedCrossings.forEach((crossing, index) => {
    const incident = incidentOwners(actual, fixture.expectedCrossingPoints[index]!);
    if (!incident.has(crossing.leftLeaf) || !incident.has(crossing.rightLeaf))
      throw new Error(`triangle-free crossing ${index} lost participating owners`);
    if (!owners[crossing.leftLeaf] || !owners[crossing.rightLeaf])
      throw new Error(`triangle-free crossing ${index} owner missing`);
  });
}

export function assertNativeTriangleFreeCubicCarrier(
  fixture: NativeTriangleFreeCubicFixtureRow,
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
    stats: { leaves: 7, pairs: 21 },
  });
  assert.equal(row.flatten_tolerance_bits, FLATTEN_BITS);
  assert.equal(row.topology_tolerance_bits, TOPOLOGY_BITS);
  assert.equal(row.flat_status, 0);
  assert.equal(row.allocations, 0);
  assert.equal(row.allocated_bytes, 1_111_552);
  assert.equal(row.inline_bytes, 12_952);
  if (!row.emission_plan || !row.commands || !row.edge_owners || !row.rounded?.output)
    throw new Error('triangle-free cubic carrier incomplete');
  assert.deepEqual(row.sizing_plan, {
    status: 0,
    verb_count: fixture.expectedCommandCount,
    point_count: fixture.expectedPointCount,
  });
  assert.deepEqual(row.emission_plan, row.sizing_plan);
  assert.deepEqual(row.statistics, {
    logical_cubics: 1,
    sizing_visits: 1,
    emission_visits: 1,
    emitted_cubic_lines: 1,
  });
  const guard = 1152 * Number.EPSILON;
  assert.deepEqual(row.flat_bounds, [-3 - guard, -10, 3 + guard, 1]);
  assertFlatBounds(row);
  assertCommandIdentity(fixture, actual);
  assertSourcePositionProof(fixture);

  const packed = packedSegments(fixture);
  const triangle = certifyTriangleFreeCubicArrangement(packed.contours, packed.kinds);
  assert.equal(triangle.status, 'CERTIFIED');
  assert.equal(triangle.leaves, 7);
  assert.equal(triangle.pairs, 21);
  assert.equal(polygonBits(triangle.certificate!.polygons), polygonBits(fixture.expectedPolygons));
  assert.deepEqual(triangle.certificate!.crossings, fixture.expectedCrossings);
  const mixed = certifyMixedTransverseCubicArrangement(packed.contours, packed.kinds);
  assert.equal(mixed.status, 'UNRESOLVED');
  assert.equal(mixed.leaves, 7);
  assert.equal(mixed.pairs, 6);
  const old = certifyTransverseCubicArrangement(packed.contours);
  assert.equal(old.status, 'UNRESOLVED');
  assert.equal(old.leaves, 7);
  assert.equal(old.pairs, 4);

  const owners = expectedOwners(fixture, packed);
  assert.equal(owners.length, 7);
  assert.deepEqual(row.edge_owners, owners);
  assert.deepEqual(row.rounded.output.source_edges, expectedSourceEdges(fixture.expectedPolygons));
  if (row.rounded.output.contributors.some((owner) => owners[owner] === undefined))
    throw new Error('triangle-free contributor lost owner attribution');
  assertCrossingOwners(fixture, actual, owners);
  assert.equal(polygonBits(row.rounded.contours), polygonBits(fixture.expectedPolygons));

  const roundedInput = roundedFixture(row);
  assert.equal(row.rounded.tau_bits, TOPOLOGY_BITS);
  assert.equal(row.rounded.profile, 'I');
  const oracle = buildRoundedFillOracle(roundedInput);
  if (!oracle.ok) throw new Error(`${fixture.id}:${fixture.rule} oracle failed: ${oracle.reason}`);
  assert.equal(oracle.properCrossings, 2);
  assert.equal(
    compare(
      oracle.exactArea,
      rational(BigInt(fixture.expectedSourceArea) * BINARY64_UNIT * BINARY64_UNIT),
    ),
    0,
  );
  verifyRoundedFillCarrier(roundedInput, oracle, row.rounded.output);
  assertCarrierMatches(oracle.carrier, row.rounded.output);
  assert.deepEqual(inspectTriangleMesh(row.rounded.output), { valid: true, issue: null });
  assertExactMeshTwiceArea(row.rounded.output, EXPECTED_MESH_TWICE_AREA);
  assert.deepEqual(row.rounded.stats, {
    input_vertices: 7,
    edges: 7,
    pair_checks: 21,
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
