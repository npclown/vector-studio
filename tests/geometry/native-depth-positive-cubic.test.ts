import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NativeCubicCommand } from './native-cubic/native.js';
import {
  parseNativeMixedCubicValueWithStats,
  type NativeMixedCubicEdgeOwner,
  type NativeMixedCubicRow,
} from './native-mixed-cubic/native.js';
import { roundedFixture } from './native-cubic/verify.js';
import {
  assertCarrierMatches,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from './rounded-fill/oracle.js';
import {
  encodeNativeDepthPositiveCubicFixture,
  fixedNativeDepthPositiveCubicFixtureRows,
} from './native-depth-positive-cubic/fixtures.js';
import { assertNativeDepthPositiveCubicCarrier } from './native-depth-positive-cubic/verify.js';
import { assertExactMeshTwiceArea } from './native-triangle-free-cubic/verify.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeDepthPositiveCubicFixtureRows();

function parseRow(line: string, index: number): NativeMixedCubicRow {
  return parseNativeMixedCubicValueWithStats(JSON.parse(line) as unknown, index, {
    leaves: 8,
    pairs: 28,
  });
}

function runNative(source: string, prefix = 'p3-native-depth-positive-cubic-') {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, prefix));
  const input = path.join(directory, 'input.txt');
  writeFileSync(input, source, { encoding: 'utf8', flag: 'wx' });
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
      'native_cubic_fill_tests::emit_depth_positive_native_cubic_fill',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_DEPTH_POSITIVE_CUBIC_INPUT: input },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(path.join(directory, 'stdout.txt'), result.stdout ?? '', {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(path.join(directory, 'stderr.txt'), result.stderr ?? '', {
    encoding: 'utf8',
    flag: 'wx',
  });
  return result;
}

function parseStrictFrame(stdout: string): readonly NativeMixedCubicRow[] {
  const begin = 'P3_NATIVE_DEPTH_POSITIVE_CUBIC_BEGIN';
  const end = 'P3_NATIVE_DEPTH_POSITIVE_CUBIC_END';
  if ((stdout.match(new RegExp(begin, 'gu')) ?? []).length !== 1)
    throw new Error('depth-positive cubic begin marker mismatch');
  if ((stdout.match(new RegExp(end, 'gu')) ?? []).length !== 1)
    throw new Error('depth-positive cubic end marker mismatch');
  const frame = new RegExp(`${begin}\\r?\\n([\\s\\S]*?)\\r?\\n${end}`, 'u').exec(stdout);
  if (!frame) throw new Error('depth-positive cubic frame incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 4) throw new Error('depth-positive cubic row count mismatch');
  const rows = lines.map(parseRow);
  const identities = rows.map(({ carrier }) => `${carrier.id}:${carrier.rule}`);
  if (new Set(identities).size !== rows.length) throw new Error('duplicate row identity');
  const expected = fixtureRows.map(({ id, rule }) => `${id}:${rule}`);
  if (JSON.stringify(identities) !== JSON.stringify(expected))
    throw new Error('row order mismatch');
  return rows;
}

let nativeRows: readonly NativeMixedCubicRow[] = [];
beforeAll(() => {
  const result = runNative(encodeNativeDepthPositiveCubicFixture(fixtureRows));
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  nativeRows = parseStrictFrame(result.stdout);
}, 300_000);

describe('P3.2z depth-positive triangle-free cubic composition', () => {
  it('freezes exact source masks, ordinals, counts, polygons, and crossings', () => {
    expect(fixtureRows.map(({ id, rule }) => [id, rule])).toEqual([
      ['depth-positive/star', 'nonzero'],
      ['depth-positive/star', 'evenodd'],
      ['depth-positive/zero-closure', 'nonzero'],
      ['depth-positive/zero-closure', 'evenodd'],
    ]);
    expect(fixtureRows.map(({ sourceKinds, packedKinds }) => [sourceKinds, packedKinds])).toEqual([
      [
        [false, true, true, true, true, true, true],
        [false, true, true, true, true, true, true],
      ],
      [
        [false, true, true, true, true, true, true],
        [false, true, true, true, true, true, true],
      ],
      [
        [true, false, true, true, true, true],
        [false, true, true, true, true],
      ],
      [
        [true, false, true, true, true, true],
        [false, true, true, true, true],
      ],
    ]);
    expect(
      fixtureRows.map(({ expectedCommandCount, expectedPointCount, expectedInputScalars }) => [
        expectedCommandCount,
        expectedPointCount,
        expectedInputScalars,
      ]),
    ).toEqual([
      [12, 20, 22],
      [12, 20, 22],
      [9, 18, 20],
      [9, 18, 20],
    ]);
    expect(
      fixtureRows.map(({ expectedLeafPartitions }) =>
        expectedLeafPartitions.map((contour) => contour.map((source) => source.length)),
      ),
    ).toEqual([
      [
        [2, 1, 1],
        [1, 1, 1, 1],
      ],
      [
        [2, 1, 1],
        [1, 1, 1, 1],
      ],
      [
        [1, 2, 1],
        [1, 1, 1],
      ],
      [
        [1, 2, 1],
        [1, 1, 1],
      ],
    ]);
    for (const fixture of fixtureRows) {
      expect(fixture.expectedCrossings).toEqual([
        { leftLeaf: 1, rightLeaf: 5, orientation: 1 },
        { leftLeaf: 1, rightLeaf: 7, orientation: -1 },
      ]);
      expect(fixture.expectedCrossingPoints).toEqual([
        [2, 1 / 32],
        [1, 1 / 16],
      ]);
      expect(fixture.expectedPolygonArea).toBe(483 / 16);
    }
    const starOwners: readonly NativeMixedCubicEdgeOwner[] = [
      { kind: 'CubicLeaf', source_verb: 1, end_numerator: 1, depth: 1 },
      { kind: 'CubicLeaf', source_verb: 1, end_numerator: 2, depth: 1 },
      { kind: 'Line', source_verb: 2 },
      { kind: 'Line', source_verb: 3 },
      { kind: 'Line', source_verb: 6 },
      { kind: 'Line', source_verb: 7 },
      { kind: 'Line', source_verb: 8 },
      { kind: 'Line', source_verb: 9 },
    ];
    const openOwners: readonly NativeMixedCubicEdgeOwner[] = [
      { kind: 'CubicLeaf', source_verb: 2, end_numerator: 1, depth: 1 },
      { kind: 'CubicLeaf', source_verb: 2, end_numerator: 2, depth: 1 },
      { kind: 'Line', source_verb: 3 },
      { kind: 'ImplicitClosure', contour: 0 },
      { kind: 'Line', source_verb: 5 },
      { kind: 'Line', source_verb: 6 },
      { kind: 'Line', source_verb: 7 },
      { kind: 'ImplicitClosure', contour: 1 },
    ];
    expect(nativeRows.map(({ carrier }) => carrier.edge_owners)).toEqual([
      starOwners,
      starOwners,
      openOwners,
      openOwners,
    ]);
    const encoded = encodeNativeDepthPositiveCubicFixture(fixtureRows);
    expect(encoded.startsWith('# p3-native-depth-positive-cubic-v1\n# rows 4\n')).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(() => encodeNativeDepthPositiveCubicFixture(fixtureRows.slice(1))).toThrow('4');
  });

  it.each(fixtureRows)(
    '$id:$rule satisfies source, topology, owner, region, and mesh proofs',
    (fixture) => {
      expect(() =>
        assertNativeDepthPositiveCubicCarrier(fixture, nativeRows[fixtureRows.indexOf(fixture)]!),
      ).not.toThrow();
    },
  );

  it('rejects outer schema, topology counters, source bits, and source kinds', () => {
    const row = nativeRows[0]!;
    expect(() =>
      parseNativeMixedCubicValueWithStats({ ...row, extra: 1 }, 0, { leaves: 8, pairs: 28 }),
    ).toThrow('keys mismatch');
    expect(() =>
      parseNativeMixedCubicValueWithStats({ ...row, source_kinds: row.source_kinds.slice(1) }, 0, {
        leaves: 8,
        pairs: 28,
      }),
    ).toThrow('count mismatch');
    expect(() => parseNativeMixedCubicValueWithStats(row, 0, { leaves: 7, pairs: 28 })).toThrow(
      'stats',
    );
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(fixtureRows[0]!, {
        ...row,
        source_kinds: row.source_kinds.map((kind, index) => (index === 0 ? !kind : kind)),
      }),
    ).toThrow();
    const changedBits = structuredClone(row.carrier.source_bits) as string[][][];
    changedBits[0]![0]![0] =
      changedBits[0]![0]![0] === 'c008000000000000' ? '0000000000000000' : 'c008000000000000';
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(fixtureRows[0]!, {
        ...row,
        carrier: { ...row.carrier, source_bits: changedBits },
      }),
    ).toThrow();
  });

  it('rejects child decoding, literal partitions, positional proof, and owner corruption', () => {
    const fixture = fixtureRows[2]!;
    const row = nativeRows[2]!;
    const commands = structuredClone(row.carrier.commands)! as NativeCubicCommand[];
    for (const provenance of [
      { source_verb: 99, end_numerator: 1, depth: 1 },
      { source_verb: 2, end_numerator: 2, depth: 1 },
      { source_verb: 2, end_numerator: 1, depth: 0 },
    ]) {
      const changed = structuredClone(commands);
      changed[2] = { ...changed[2]!, provenance };
      expect(() =>
        assertNativeDepthPositiveCubicCarrier(fixture, {
          ...row,
          carrier: { ...row.carrier, commands: changed },
        }),
      ).toThrow();
    }
    const changedEnd = structuredClone(commands);
    changedEnd[2] = { ...changedEnd[2]!, point: [0, 1] };
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, commands: changedEnd },
      }),
    ).toThrow();
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, commands: commands.filter((_, index) => index !== 2) },
      }),
    ).toThrow();
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, commands: commands.filter((_, index) => index !== 1) },
      }),
    ).toThrow();
    const proofCommands = structuredClone(commands);
    proofCommands[2] = { ...proofCommands[2]!, point: [0, 1] };
    const proofPartitions = fixture.expectedLeafPartitions.map((contour, contourIndex) =>
      contour.map((source, sourceIndex) =>
        source.map((line, lineIndex) =>
          contourIndex === 0 && sourceIndex === 1 && lineIndex === 0
            ? { ...line, end: [0, 1] as const }
            : line,
        ),
      ),
    );
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(
        { ...fixture, expectedLeafPartitions: proofPartitions },
        { ...row, carrier: { ...row.carrier, commands: proofCommands } },
      ),
    ).toThrow('boundary');
    const owners = row.carrier.edge_owners!;
    const corruptions: readonly (readonly NativeMixedCubicEdgeOwner[])[] = [
      [{ kind: 'Line', source_verb: 1 }, ...owners],
      owners.filter((_, index) => index !== 1),
      owners.map((owner, index) => (index === 5 ? { kind: 'Line', source_verb: 99 } : owner)),
      owners.map((owner, index) => (index === 7 ? { kind: 'ImplicitClosure', contour: 0 } : owner)),
    ];
    for (const edge_owners of corruptions)
      expect(() =>
        assertNativeDepthPositiveCubicCarrier(fixture, {
          ...row,
          carrier: { ...row.carrier, edge_owners },
        }),
      ).toThrow();
  });

  it('rejects missing, inward, and excessive flat guards', () => {
    for (const [index, row] of nativeRows.entries()) {
      const fixture = fixtureRows[index]!;
      const bounds = row.carrier.flat_bounds!;
      const guard = 1152 * Number.EPSILON;
      for (const minX of [-3, -3 + 1 / 16, -3 - guard - 1 / 16])
        expect(() =>
          assertNativeDepthPositiveCubicCarrier(fixture, {
            ...row,
            carrier: { ...row.carrier, flat_bounds: [minX, bounds[1], bounds[2], bounds[3]] },
          }),
        ).toThrow();
    }
  });

  it('rejects both crossing ledgers, owner incidence, source edges, contributors, cells, and area', () => {
    const fixture = fixtureRows[0]!;
    const row = nativeRows[0]!;
    for (const index of [0, 1]) {
      const expectedCrossings = fixture.expectedCrossings.map((crossing, current) =>
        current === index
          ? { ...crossing, orientation: -crossing.orientation as -1 | 1 }
          : crossing,
      );
      expect(() =>
        assertNativeDepthPositiveCubicCarrier({ ...fixture, expectedCrossings }, row),
      ).toThrow();
      const expectedCrossingPoints = fixture.expectedCrossingPoints.map((point, current) =>
        current === index ? ([99, 99] as const) : point,
      );
      expect(() =>
        assertNativeDepthPositiveCubicCarrier({ ...fixture, expectedCrossingPoints }, row),
      ).toThrow();
      const wrongIndex = fixture.expectedCrossings.map((crossing, current) =>
        current === index ? { ...crossing, rightLeaf: 6 } : crossing,
      );
      expect(() =>
        assertNativeDepthPositiveCubicCarrier({ ...fixture, expectedCrossings: wrongIndex }, row),
      ).toThrow();

      const output = row.carrier.rounded!.output!;
      const point = fixture.expectedCrossingPoints[index]!;
      const nodes = output.nodes.flatMap((node, nodeIndex) =>
        node.point[0] === point[0] && node.point[1] === point[1] ? [nodeIndex] : [],
      );
      const partner = fixture.expectedCrossings[index]!.rightLeaf;
      const sections = output.sections.map((section) =>
        nodes.includes(section.node) && section.edge === partner
          ? { ...section, edge: 1 }
          : section,
      );
      const contributorIndices = new Set<number>();
      for (const span of output.spans) {
        if (!nodes.includes(span.lower) && !nodes.includes(span.upper)) continue;
        for (
          let contributor = span.vertical_sources.start;
          contributor < span.vertical_sources.start + span.vertical_sources.count;
          contributor += 1
        )
          contributorIndices.add(contributor);
      }
      const contributors = output.contributors.map((owner, contributorIndex) =>
        contributorIndices.has(contributorIndex) && owner === partner ? 1 : owner,
      );
      expect(() =>
        assertNativeDepthPositiveCubicCarrier(fixture, {
          ...row,
          carrier: {
            ...row.carrier,
            rounded: {
              ...row.carrier.rounded!,
              output: { ...output, sections, contributors },
            },
          },
        }),
      ).toThrow(`triangle-free crossing ${index} lost participating owners`);
    }
    const output = row.carrier.rounded!.output!;
    const wrongEdges = output.source_edges.map((edge, index) =>
      index === 4 ? { ...edge, contour: 0 } : edge,
    );
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(fixture, {
        ...row,
        carrier: {
          ...row.carrier,
          rounded: { ...row.carrier.rounded!, output: { ...output, source_edges: wrongEdges } },
        },
      }),
    ).toThrow();
    const roundedInput = roundedFixture(row.carrier);
    const oracle = buildRoundedFillOracle(roundedInput);
    if (!oracle.ok) throw new Error(oracle.reason);
    expect(() =>
      verifyRoundedFillCarrier(roundedInput, oracle, {
        ...output,
        contributors: [8, ...output.contributors.slice(1)],
      }),
    ).toThrow();
    const cells = output.cells.map((cell, index) =>
      index === 0 ? { ...cell, lower_after: cell.lower_after + 1 } : cell,
    );
    expect(() => assertCarrierMatches(oracle.carrier, { ...output, cells })).toThrow();
    const unit = 1n << 1074n;
    expect(() => assertExactMeshTwiceArea(output, (483n * unit * unit) / 8n)).toThrow();
    expect(() => assertExactMeshTwiceArea(output, (121n * unit * unit) / 2n)).toThrow();
    const indices = [...output.indices];
    [indices[0], indices[1]] = [indices[1]!, indices[0]!];
    expect(() =>
      assertExactMeshTwiceArea({ ...output, indices }, 121n * (1n << 2147n) - (1n << 2099n)),
    ).toThrow();
    expect(() =>
      assertNativeDepthPositiveCubicCarrier(fixture, {
        ...row,
        carrier: {
          ...row.carrier,
          rounded: { ...row.carrier.rounded!, output: { ...output, indices } },
        },
      }),
    ).toThrow();
  });

  it('rejects malformed native masks and marked source shapes before frames', () => {
    const source = encodeNativeDepthPositiveCubicFixture(fixtureRows);
    const first = source.split('\n')[2]!;
    const malformed: readonly (readonly [string, string, string])[] = [
      [
        'header',
        source.replace('# p3-native-depth-positive-cubic-v1', '# bad-v1'),
        'invalid fixture header',
      ],
      ['row-count', source.replace('# rows 4', '# rows 3'), 'invalid fixture row count header'],
      ['mask-missing', source.replace(' OK 0111111 |', ' OK |'), 'invalid fixture row header'],
      [
        'mask-extra',
        source.replace(' OK 0111111 |', ' OK 0111111 extra |'),
        'invalid fixture row header',
      ],
      ['mask-length', source.replace(' OK 0111111 |', ' OK 011111 |'), 'invalid source kind mask'],
      [
        'mask-nonbinary',
        source.replace(' OK 0111111 |', ' OK 0211111 |'),
        'invalid source kind mask',
      ],
    ];
    const firstLineBits = fixtureRows[0]!.sourceBits[0]![1]!.join(',');
    const changed = [...fixtureRows[0]!.sourceBits[0]![1]!];
    changed[2] = changed[4]!;
    const cases = [
      ...malformed,
      [
        'marked-shape',
        source.replace(first, first.replace(firstLineBits, changed.join(','))),
        'marked LINE source shape invalid',
      ] as const,
    ];
    for (const [label, corrupted, error] of cases) {
      const result = runNative(corrupted, `p3-native-depth-positive-cubic-bad-${label}-`);
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, combined).not.toBe(0);
      expect(combined).toContain(error);
      expect(combined).not.toContain('P3_NATIVE_DEPTH_POSITIVE_CUBIC_BEGIN');
    }
  });

  it('rejects missing, extra, duplicate, reordered, and malformed frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_DEPTH_POSITIVE_CUBIC_BEGIN\n${body.join('\n')}\nP3_NATIVE_DEPTH_POSITIVE_CUBIC_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() => parseStrictFrame(frame([lines[0]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'duplicate',
    );
    expect(() => parseStrictFrame(frame([lines[1]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'row order',
    );
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_DEPTH_POSITIVE_CUBIC_BEGIN', 'WRONG')),
    ).toThrow('begin');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_DEPTH_POSITIVE_CUBIC_END', 'WRONG')),
    ).toThrow('end');
    expect(() => parseStrictFrame(`P3_NATIVE_DEPTH_POSITIVE_CUBIC_BEGIN\n${frame(lines)}`)).toThrow(
      'begin',
    );
    expect(() => parseStrictFrame(`${frame(lines)}\nP3_NATIVE_DEPTH_POSITIVE_CUBIC_END`)).toThrow(
      'end',
    );
  });
});
