import type {
  Cubic,
  Point,
  ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/types.js';
import { certifyCubicBoundary } from '../cubic-boundary/oracle.js';
import { bitsOf } from '../rounded-fill/exact.js';
import type { FixtureRow } from '../rounded-fill/types.js';
import type { NativeCubicSourceFixtureRow } from './fixtures.js';
import type { NativeCubicCommand, NativeCubicEdgeOwner, NativeCubicRow } from './native.js';

export type ActualSegment = Readonly<{
  cubic: Cubic;
  sourceVerbOrdinal: number;
  lines: readonly ReferenceFlattenedLine[];
}>;

function mathPointEqual(left: Point, right: Point): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

export function normalizedPoint([x, y]: Point): Point {
  return [x === 0 ? 0 : x, y === 0 ? 0 : y];
}

export function assertFixtureIdentity(
  fixture: NativeCubicSourceFixtureRow,
  row: NativeCubicRow,
): void {
  if (row.id !== fixture.id || row.rule !== fixture.rule) throw new Error('row identity mismatch');
  if (JSON.stringify(row.source_bits) !== JSON.stringify(fixture.sourceBits))
    throw new Error('source bits mismatch');
}

function assertPreservedCommand(
  command: NativeCubicCommand | undefined,
  verb: 0 | 3,
  sourceVerbOrdinal: number,
  point: Point | null,
  label: string,
): void {
  if (command?.verb !== verb) throw new Error(`${label} verb mismatch`);
  if (
    command.provenance.source_verb !== sourceVerbOrdinal ||
    command.provenance.end_numerator !== 1 ||
    command.provenance.depth !== 0
  )
    throw new Error(`${label} provenance mismatch`);
  if (point === null) {
    if (command.point !== null) throw new Error(`${label} point mismatch`);
  } else if (command.point === null || !mathPointEqual(command.point, point)) {
    throw new Error(`${label} point mismatch`);
  }
}

export function actualSegments(
  fixture: NativeCubicSourceFixtureRow,
  commands: readonly NativeCubicCommand[],
): readonly (readonly ActualSegment[])[] {
  let commandIndex = 0;
  const contours = fixture.contours.map((contour, contourIndex) => {
    const first = contour.cubics[0]![0];
    assertPreservedCommand(
      commands[commandIndex],
      0,
      contour.moveVerbOrdinal,
      first,
      `contour ${contourIndex} MOVE`,
    );
    commandIndex += 1;
    const segments = contour.cubics.map((cubic, cubicIndex) => {
      const sourceVerbOrdinal = contour.cubicVerbOrdinals[cubicIndex]!;
      const lines: ReferenceFlattenedLine[] = [];
      while (
        commands[commandIndex]?.verb === 1 &&
        commands[commandIndex]!.provenance.source_verb === sourceVerbOrdinal
      ) {
        const command = commands[commandIndex]!;
        if (command.point === null) throw new Error('LINE command lacks a point');
        lines.push({
          end: command.point,
          provenance: {
            sourceVerbOrdinal,
            endNumerator: command.provenance.end_numerator,
            depth: command.provenance.depth,
          },
        });
        commandIndex += 1;
      }
      if (lines.length === 0)
        throw new Error(`source cubic ${sourceVerbOrdinal} emitted no leaves`);
      const boundary = certifyCubicBoundary({
        cubic,
        lines,
        screen: [1, 0, 0, 1],
        sourceVerbOrdinal,
      });
      if (!boundary.ok)
        throw new Error(`source cubic ${sourceVerbOrdinal} boundary ${boundary.status}`);
      return { cubic, sourceVerbOrdinal, lines };
    });
    if (contour.closeVerbOrdinal !== null) {
      assertPreservedCommand(
        commands[commandIndex],
        3,
        contour.closeVerbOrdinal,
        null,
        `contour ${contourIndex} CLOSE`,
      );
      commandIndex += 1;
    }
    return segments;
  });
  if (commandIndex !== commands.length) throw new Error('unconsumed native commands');
  return contours;
}

export function collectedContours(
  contours: readonly (readonly ActualSegment[])[],
): readonly (readonly Point[])[] {
  return contours.map((segments) => {
    const points: Point[] = [segments[0]!.cubic[0]];
    for (const segment of segments) for (const line of segment.lines) points.push(line.end);
    if (mathPointEqual(points[0]!, points.at(-1)!)) points.pop();
    return points;
  });
}

export function expectedOwners(
  fixture: NativeCubicSourceFixtureRow,
  contours: readonly (readonly ActualSegment[])[],
): readonly NativeCubicEdgeOwner[] {
  const owners: NativeCubicEdgeOwner[] = [];
  contours.forEach((segments, contourIndex) => {
    for (const segment of segments) {
      for (const line of segment.lines) {
        owners.push({
          kind: 'CubicLeaf',
          source_verb: segment.sourceVerbOrdinal,
          end_numerator: line.provenance.endNumerator,
          depth: line.provenance.depth,
        });
      }
    }
    if (fixture.contours[contourIndex]!.closeVerbOrdinal === null)
      owners.push({ kind: 'ImplicitClosure', contour: contourIndex });
  });
  return owners;
}

export function assertOwnerMapping(
  owners: readonly NativeCubicEdgeOwner[],
  contours: readonly (readonly Point[])[],
  row: NativeCubicRow,
): void {
  if (!row.edge_owners || !row.rounded?.output) throw new Error('owner mapping output missing');
  if (JSON.stringify(row.edge_owners) !== JSON.stringify(owners))
    throw new Error('edge owner mapping mismatch');
  const expectedEdges = contours.flatMap((contour, contourIndex) =>
    contour.map((_, vertex) => ({
      contour: contourIndex,
      start_vertex: vertex,
      end_vertex: (vertex + 1) % contour.length,
    })),
  );
  if (JSON.stringify(row.rounded.output.source_edges) !== JSON.stringify(expectedEdges))
    throw new Error('rounded source edge order mismatch');
  if (row.rounded.output.contributors.some((ownerIndex) => owners[ownerIndex] === undefined))
    throw new Error('rounded contributor lost owner attribution');
}

export function roundedFixture(row: NativeCubicRow): FixtureRow {
  if (!row.rounded) throw new Error('rounded result missing');
  return {
    id: row.id,
    rule: row.rule,
    tauBits: bitsOf(1 / 16),
    expectation: 'OK',
    profile: 'I',
    contours: row.rounded.contours.map((contour) =>
      contour.map(([x, y]) => [bitsOf(x), bitsOf(y)] as const),
    ),
  };
}

export function assertFlatBounds(row: NativeCubicRow): void {
  if (!row.flat_bounds || !row.commands) throw new Error('flat bounds output missing');
  const [minX, minY, maxX, maxY] = row.flat_bounds;
  if (minX > maxX || minY > maxY) throw new Error('flat bounds are unordered');
  for (const command of row.commands) {
    if (command.point === null) continue;
    const [x, y] = command.point;
    if (x < minX || x > maxX || y < minY || y > maxY)
      throw new Error('flat bounds exclude an emitted point');
  }
}
