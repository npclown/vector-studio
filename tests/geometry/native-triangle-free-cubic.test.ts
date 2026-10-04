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
  encodeNativeTriangleFreeCubicFixture,
  fixedNativeTriangleFreeCubicFixtureRows,
} from './native-triangle-free-cubic/fixtures.js';
import {
  assertExactMeshTwiceArea,
  assertNativeTriangleFreeCubicCarrier,
} from './native-triangle-free-cubic/verify.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeTriangleFreeCubicFixtureRows();

function parseRow(line: string, index: number): NativeMixedCubicRow {
  return parseNativeMixedCubicValueWithStats(JSON.parse(line) as unknown, index, {
    leaves: 7,
    pairs: 21,
  });
}

function runNative(source: string, prefix = 'p3-native-triangle-free-cubic-') {
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
      'native_cubic_fill_tests::emit_triangle_free_native_cubic_fill',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_TRIANGLE_FREE_CUBIC_INPUT: input },
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
  const begin = 'P3_NATIVE_TRIANGLE_FREE_CUBIC_BEGIN';
  const end = 'P3_NATIVE_TRIANGLE_FREE_CUBIC_END';
  if ((stdout.match(new RegExp(begin, 'gu')) ?? []).length !== 1)
    throw new Error('triangle-free cubic begin marker mismatch');
  if ((stdout.match(new RegExp(end, 'gu')) ?? []).length !== 1)
    throw new Error('triangle-free cubic end marker mismatch');
  const frame = new RegExp(`${begin}\\r?\\n([\\s\\S]*?)\\r?\\n${end}`, 'u').exec(stdout);
  if (!frame) throw new Error('triangle-free cubic frame incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 4) throw new Error('triangle-free cubic row count mismatch');
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
  const result = runNative(encodeNativeTriangleFreeCubicFixture(fixtureRows));
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  nativeRows = parseStrictFrame(result.stdout);
}, 300_000);

describe('P3.2y canonical triangle-free cubic composition', () => {
  it('freezes exact source masks, ordinals, counts, polygons, and crossings', () => {
    expect(fixtureRows.map(({ id, rule }) => [id, rule])).toEqual([
      ['triangle-free/star', 'nonzero'],
      ['triangle-free/star', 'evenodd'],
      ['triangle-free/zero-closure', 'nonzero'],
      ['triangle-free/zero-closure', 'evenodd'],
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
      [11, 18, 22],
      [11, 18, 22],
      [8, 16, 20],
      [8, 16, 20],
    ]);
    for (const fixture of fixtureRows) {
      expect(fixture.expectedCrossings).toEqual([
        { leftLeaf: 0, rightLeaf: 4, orientation: 1 },
        { leftLeaf: 0, rightLeaf: 6, orientation: -1 },
      ]);
      expect(fixture.expectedCrossingPoints).toEqual([
        [1, 0],
        [-1, 0],
      ]);
      expect(fixture.expectedSourceArea).toBe(30);
    }
    const encoded = encodeNativeTriangleFreeCubicFixture(fixtureRows);
    expect(encoded.startsWith('# p3-native-triangle-free-cubic-v1\n# rows 4\n')).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(() => encodeNativeTriangleFreeCubicFixture(fixtureRows.slice(1))).toThrow('4');
  });

  it.each(fixtureRows)(
    '$id:$rule satisfies source, topology, owner, region, and mesh proofs',
    (fixture) => {
      expect(() =>
        assertNativeTriangleFreeCubicCarrier(fixture, nativeRows[fixtureRows.indexOf(fixture)]!),
      ).not.toThrow();
    },
  );

  it('rejects outer schema, topology counters, source bits, and source kinds', () => {
    const row = nativeRows[0]!;
    expect(() =>
      parseNativeMixedCubicValueWithStats({ ...row, extra: 1 }, 0, { leaves: 7, pairs: 21 }),
    ).toThrow('keys mismatch');
    expect(() =>
      parseNativeMixedCubicValueWithStats({ ...row, source_kinds: row.source_kinds.slice(1) }, 0, {
        leaves: 7,
        pairs: 21,
      }),
    ).toThrow('count mismatch');
    expect(() => parseNativeMixedCubicValueWithStats(row, 0, { leaves: 8, pairs: 21 })).toThrow(
      'stats',
    );
    expect(() =>
      assertNativeTriangleFreeCubicCarrier(fixtureRows[0]!, {
        ...row,
        source_kinds: row.source_kinds.map((kind, index) => (index === 0 ? !kind : kind)),
      }),
    ).toThrow();
    const changedBits = structuredClone(row.carrier.source_bits) as string[][][];
    changedBits[0]![0]![0] =
      changedBits[0]![0]![0] === 'c008000000000000' ? '0000000000000000' : 'c008000000000000';
    expect(() =>
      assertNativeTriangleFreeCubicCarrier(fixtureRows[0]!, {
        ...row,
        carrier: { ...row.carrier, source_bits: changedBits },
      }),
    ).toThrow();
  });

  it('rejects command provenance/end and zero/real/second-contour/closure owner corruption', () => {
    const fixture = fixtureRows[2]!;
    const row = nativeRows[2]!;
    const commands = structuredClone(row.carrier.commands)! as NativeCubicCommand[];
    for (const provenance of [
      { source_verb: 99, end_numerator: 1, depth: 0 },
      { source_verb: 1, end_numerator: 2, depth: 0 },
      { source_verb: 1, end_numerator: 1, depth: 1 },
    ]) {
      const changed = structuredClone(commands);
      changed[1] = { ...changed[1]!, provenance };
      expect(() =>
        assertNativeTriangleFreeCubicCarrier(fixture, {
          ...row,
          carrier: { ...row.carrier, commands: changed },
        }),
      ).toThrow();
    }
    const changedEnd = structuredClone(commands);
    changedEnd[1] = { ...changedEnd[1]!, point: [99, 0] };
    expect(() =>
      assertNativeTriangleFreeCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, commands: changedEnd },
      }),
    ).toThrow();
    expect(() =>
      assertNativeTriangleFreeCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, commands: commands.filter((_, index) => index !== 1) },
      }),
    ).toThrow();
    const owners = row.carrier.edge_owners!;
    const corruptions: readonly (readonly NativeMixedCubicEdgeOwner[])[] = [
      [{ kind: 'Line', source_verb: 1 }, ...owners],
      owners.slice(1),
      owners.map((owner, index) => (index === 4 ? { kind: 'Line', source_verb: 99 } : owner)),
      owners.map((owner, index) => (index === 6 ? { kind: 'ImplicitClosure', contour: 0 } : owner)),
    ];
    for (const edge_owners of corruptions)
      expect(() =>
        assertNativeTriangleFreeCubicCarrier(fixture, {
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
          assertNativeTriangleFreeCubicCarrier(fixture, {
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
        assertNativeTriangleFreeCubicCarrier({ ...fixture, expectedCrossings }, row),
      ).toThrow();
      const expectedCrossingPoints = fixture.expectedCrossingPoints.map((point, current) =>
        current === index ? ([99, 99] as const) : point,
      );
      expect(() =>
        assertNativeTriangleFreeCubicCarrier({ ...fixture, expectedCrossingPoints }, row),
      ).toThrow();
      const wrongIndex = fixture.expectedCrossings.map((crossing, current) =>
        current === index ? { ...crossing, rightLeaf: 5 } : crossing,
      );
      expect(() =>
        assertNativeTriangleFreeCubicCarrier({ ...fixture, expectedCrossings: wrongIndex }, row),
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
        assertNativeTriangleFreeCubicCarrier(fixture, {
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
      index === 3 ? { ...edge, contour: 0 } : edge,
    );
    expect(() =>
      assertNativeTriangleFreeCubicCarrier(fixture, {
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
        contributors: [7, ...output.contributors.slice(1)],
      }),
    ).toThrow();
    const cells = output.cells.map((cell, index) =>
      index === 0 ? { ...cell, lower_after: cell.lower_after + 1 } : cell,
    );
    expect(() => assertCarrierMatches(oracle.carrier, { ...output, cells })).toThrow();
    const unit = 1n << 1074n;
    expect(() => assertExactMeshTwiceArea(output, 60n * unit * unit)).toThrow();
    expect(() => assertExactMeshTwiceArea(output, (963n * unit * unit) / 16n)).toThrow();
    const indices = [...output.indices];
    [indices[0], indices[1]] = [indices[1]!, indices[0]!];
    expect(() =>
      assertExactMeshTwiceArea({ ...output, indices }, 963n * (1n << 2144n) - (1n << 2100n)),
    ).toThrow();
    expect(() =>
      assertNativeTriangleFreeCubicCarrier(fixture, {
        ...row,
        carrier: {
          ...row.carrier,
          rounded: { ...row.carrier.rounded!, output: { ...output, indices } },
        },
      }),
    ).toThrow();
  });

  it('rejects malformed native masks and marked source shapes before frames', () => {
    const source = encodeNativeTriangleFreeCubicFixture(fixtureRows);
    const first = source.split('\n')[2]!;
    const malformed: readonly (readonly [string, string, string])[] = [
      [
        'header',
        source.replace('# p3-native-triangle-free-cubic-v1', '# bad-v1'),
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
      const result = runNative(corrupted, `p3-native-triangle-free-cubic-bad-${label}-`);
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, combined).not.toBe(0);
      expect(combined).toContain(error);
      expect(combined).not.toContain('P3_NATIVE_TRIANGLE_FREE_CUBIC_BEGIN');
    }
  });

  it('rejects missing, extra, duplicate, reordered, and malformed frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_TRIANGLE_FREE_CUBIC_BEGIN\n${body.join('\n')}\nP3_NATIVE_TRIANGLE_FREE_CUBIC_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() => parseStrictFrame(frame([lines[0]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'duplicate',
    );
    expect(() => parseStrictFrame(frame([lines[1]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'row order',
    );
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_TRIANGLE_FREE_CUBIC_BEGIN', 'WRONG')),
    ).toThrow('begin');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_TRIANGLE_FREE_CUBIC_END', 'WRONG')),
    ).toThrow('end');
    expect(() => parseStrictFrame(`P3_NATIVE_TRIANGLE_FREE_CUBIC_BEGIN\n${frame(lines)}`)).toThrow(
      'begin',
    );
    expect(() => parseStrictFrame(`${frame(lines)}\nP3_NATIVE_TRIANGLE_FREE_CUBIC_END`)).toThrow(
      'end',
    );
  });
});
