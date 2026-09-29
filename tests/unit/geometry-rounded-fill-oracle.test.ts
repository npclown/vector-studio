import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectLineFillMesh } from '../../packages/geometry-reference/src/fill-region.js';
import { inspectTriangleMesh } from '../../packages/geometry-reference/src/triangle-mesh.js';
import { compare, exactBits, fromBits, mul, rational } from '../geometry/rounded-fill/exact.js';
import {
  parseRoundedFillFixture,
  readRoundedFillFixture,
} from '../geometry/rounded-fill/fixture.js';
import { parseNativeRoundedRow } from '../geometry/rounded-fill/native.js';
import {
  assertCarrierMatches,
  assertEmbeddingCertificate,
  assertSourceEcho,
  buildRoundedFillOracle,
  countColumnsOutsideNearestBracket,
  countMovableColumns,
  nextAdmissibleColumn,
  structuralCounts,
  verifyRoundedFillCarrier,
} from '../geometry/rounded-fill/oracle.js';
import type { ExpectedCarrier, FixtureRow, OracleSuccess } from '../geometry/rounded-fill/types.js';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(root, 'tests/fixtures/p3-rounded-fill-v1.txt');
const rows = readRoundedFillFixture(fixture);
const results = rows.map((row) => buildRoundedFillOracle(row));
const UNIT = 1n << 1074n;
const AREA_UNIT = UNIT * UNIT;

function required<T>(value: T | null | undefined, label = 'required test value'): T {
  if (value === undefined || value === null) throw new Error(label);
  return value;
}

const exactArea = (integer: number) => rational(BigInt(integer) * AREA_UNIT);
const resultFor = (id: string, rule: FixtureRow['rule']): OracleSuccess => {
  const index = rows.findIndex((row) => row.id === id && row.rule === rule);
  const result = results[index];
  if (!result?.ok) throw new Error(`${id}:${rule} is not a successful oracle row`);
  return result;
};
const rowFor = (id: string, rule: FixtureRow['rule']): FixtureRow =>
  required(
    rows.find((row) => row.id === id && row.rule === rule),
    `${id}:${rule} fixture row`,
  );

function signedArea(contour: FixtureRow['contours'][number]): number {
  let twice = 0;
  for (let index = 0; index < contour.length; index += 1) {
    const [ax, ay] = required(contour[index]).map(fromBits) as [number, number];
    const [bx, by] = required(contour[(index + 1) % contour.length]).map(fromBits) as [
      number,
      number,
    ];
    twice += ax * by - ay * bx;
  }
  return twice / 2;
}

describe('P3.2e independent rounded-fill oracle', () => {
  it('freezes the 202-row order, rule pairs, profile cycle, and policy split', () => {
    expect(rows).toHaveLength(202);
    expect(rows.filter(({ expectation }) => expectation === 'OK')).toHaveLength(198);
    expect(rows.filter(({ expectation }) => expectation === 'TOPOLOGY_AMBIGUOUS')).toHaveLength(4);
    for (let index = 0; index < rows.length; index += 2) {
      expect(required(rows[index]).id).toBe(required(rows[index + 1]).id);
      expect([required(rows[index]).rule, required(rows[index + 1]).rule]).toEqual([
        'nonzero',
        'evenodd',
      ]);
    }
    expect(rows.map(({ profile }) => profile)).toEqual(
      rows.map((_, index) => ['I', 'R16', 'D32', 'S192'][index % 4]),
    );
  });

  it('constructs and accepts all 198 canonical carriers within frozen bounds', () => {
    rows.forEach((row, index) => {
      const result = results[index];
      if (row.expectation !== 'OK') return;
      if (!result?.ok) throw new Error(`${row.id}:${row.rule} unexpectedly failed`);
      assertCarrierMatches(result.carrier, result.carrier);
      verifyRoundedFillCarrier(row, result, result.carrier);
      const counts = structuralCounts(result);
      const inputVertices = row.contours.reduce((sum, contour) => sum + contour.length, 0);
      expect(row.contours.length).toBeLessThanOrEqual(16);
      expect(inputVertices).toBeLessThanOrEqual(32);
      expect(result.carrier.source_edges.length).toBeLessThanOrEqual(32);
      expect(
        (result.carrier.source_edges.length * (result.carrier.source_edges.length - 1)) / 2,
      ).toBeLessThanOrEqual(496);
      expect(result.rawEvents).toBeLessThanOrEqual(560);
      if (/^[SXHO]\d{2}$/u.test(row.id) || row.id.startsWith('M-')) {
        expect(result.carrier.source_edges.length).toBeLessThanOrEqual(8);
        expect(result.properCrossings).toBeLessThanOrEqual(20);
      }
      expect(counts.columns).toBeLessThanOrEqual(row.id === 'R04' ? 7 : 28);
      expect(counts.nodes).toBeLessThanOrEqual(row.id === 'R04' ? 56 : 224);
      expect(counts.triangles).toBeLessThanOrEqual(row.id === 'R04' ? 48 : 216);
      expect(result.carrier.sections.length).toBeLessThanOrEqual(8192);
      expect(result.carrier.cells.length).toBeLessThanOrEqual(256);
      expect(result.carrier.boundaries.length).toBeLessThanOrEqual(512);
      expect(result.carrier.contributors.length).toBeLessThanOrEqual(16_384);
      expect(result.carrier.vertices.length).toBeLessThanOrEqual(256);
      expect(inspectTriangleMesh(result.carrier)).toEqual({ valid: true, issue: null });
    });
  });

  it('proves the four pinned-window ambiguity rows infeasible without a topology shortcut', () => {
    rows.forEach((row, index) => {
      if (row.expectation !== 'TOPOLOGY_AMBIGUOUS') return;
      expect(results[index]).toMatchObject({ ok: false });
    });
    expect(
      rows.filter(({ id }) => id === 'A02').every(({ contours }) => contours.length === 2),
    ).toBe(true);
    const a01 = required(results[198]);
    const a02 = required(results[200]);
    if (a01.ok || a02.ok) throw new Error('ambiguity control unexpectedly succeeded');
    expect(a01.reason).toContain('x monotone');
    expect(a02.reason).toContain('y monotone');
  });

  it('checks frozen analytic areas independently of rounded triangles', () => {
    const expected = new Map<string, number>([
      ['F01', 100],
      ['F02:nonzero', 100],
      ['F02:evenodd', 84],
      ['F03', 84],
      ['F04:nonzero', 100],
      ['F04:evenodd', 0],
      ['F05', 0],
      ['F06', 8],
      ['F07', 8],
      ['F08', 32],
      ['F09-repeat', 100],
      ['F09-permuted:nonzero', 100],
      ['F09-permuted:evenodd', 84],
      ['F10:nonzero', 24],
      ['F10:evenodd', 16],
      ['F10-reversed', 16],
      ['F11', 32],
      ['F03-global-reversed', 84],
      ['F06-global-reversed', 8],
      ['F10-global-reversed:nonzero', 24],
      ['F10-global-reversed:evenodd', 16],
    ]);
    for (const row of rows.slice(0, 32)) {
      const area = expected.get(`${row.id}:${row.rule}`) ?? expected.get(row.id);
      expect(area, row.id).toBeDefined();
      const analyticArea = required(area);
      expect(
        compare(resultFor(row.id, row.rule).exactArea, exactArea(analyticArea)),
        `${row.id}:${row.rule}`,
      ).toBe(0);
      const result = resultFor(row.id, row.rule);
      expect(
        inspectLineFillMesh({
          contours: row.contours.map((contour) =>
            contour.map(([x, y]) => [fromBits(x), fromBits(y)] as const),
          ),
          rule: row.rule,
          mesh: {
            vertices: result.carrier.vertices,
            indices: result.carrier.indices,
            bounds: result.carrier.bounds,
            expectedArea: analyticArea,
          },
        }),
        `${row.id}:${row.rule} unchanged exact region oracle`,
      ).toEqual({ valid: true, issue: null });
    }
    for (const row of rows.filter(({ id }) => /^[SHO]\d{2}$/u.test(id))) {
      const points = row.contours.flatMap((contour) =>
        contour.map(([x, y]) => {
          const py = fromBits(y);
          return { u: fromBits(x) - py / 4, y: py };
        }),
      );
      const uRange = Math.max(...points.map(({ u }) => u)) - Math.min(...points.map(({ u }) => u));
      const yRange = Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y));
      const family = row.id[0];
      const width = family === 'O' ? (2 * uRange) / 3 : uRange;
      const height = family === 'O' ? (4 * yRange) / 5 : yRange;
      const sameOrientation =
        row.contours.length === 1 ||
        Math.sign(signedArea(required(row.contours[0]))) ===
          Math.sign(signedArea(required(row.contours[1])));
      let area: number;
      if (family === 'S') area = (3 * width * height) / 4;
      else if (family === 'H')
        area =
          row.rule === 'nonzero' && sameOrientation
            ? width * height
            : width * height - (width - 4) * (height - 4);
      else
        area =
          row.rule === 'nonzero' && sameOrientation
            ? (13 * width * height) / 8
            : (5 * width * height) / 4;
      expect(Number.isInteger(area), `${row.id}:${row.rule} analytic area`).toBe(true);
      expect(compare(resultFor(row.id, row.rule).exactArea, exactArea(area))).toBe(0);
    }
    for (const id of ['S00', 'X00', 'H00', 'O00']) {
      for (const rule of ['nonzero', 'evenodd'] as const) {
        const base = resultFor(id, rule).exactArea;
        expect(compare(resultFor(`M-${id}-translate`, rule).exactArea, base)).toBe(0);
        expect(compare(resultFor(`M-${id}-reflect`, rule).exactArea, base)).toBe(0);
        expect(
          compare(
            resultFor(`M-${id}-scale`, rule).exactArea,
            mul(base, rational(1n, 1024n * 1024n)),
          ),
        ).toBe(0);
      }
    }
  });

  it('uses the complete full-window search for the R04 near cluster', () => {
    expect(countMovableColumns(resultFor('R04', 'nonzero'))).toBeGreaterThanOrEqual(3);
    expect(countMovableColumns(resultFor('R04', 'evenodd'))).toBeGreaterThanOrEqual(3);
    expect(countColumnsOutsideNearestBracket(resultFor('R04', 'nonzero'))).toBeGreaterThanOrEqual(
      1,
    );
    expect(countColumnsOutsideNearestBracket(resultFor('R04', 'evenodd'))).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('rejects every frozen corruption category for its expected carrier field', () => {
    const f01 = resultFor('F01', 'nonzero').carrier;
    const f02Evenodd = resultFor('F02', 'evenodd').carrier;
    const firstBoundary = required(f01.boundaries[0]);
    const firstCell = required(f01.cells[0]);
    const firstColumn = required(f01.columns[0]);
    const secondColumn = required(f01.columns[1]);
    const firstNode = required(f01.nodes[0]);
    const firstSpan = required(f01.spans[0]);
    const i0 = required(f01.indices[0]);
    const i1 = required(f01.indices[1]);
    const i2 = required(f01.indices[2]);
    const r04Row = rowFor('R04', 'nonzero');
    const r04 = resultFor('R04', 'nonzero');
    const higher = required(nextAdmissibleColumn(r04Row, r04), 'R04 admissible higher key');
    const higherNodes = r04.carrier.nodes.map((node) =>
      node.column === higher.index
        ? { ...node, point: [higher.value, node.point[1]] as const }
        : node,
    );
    const higherVertices = [...r04.carrier.vertices];
    higherNodes.forEach((node) => {
      if (node.vertex !== null) higherVertices[node.vertex] = node.point;
    });
    const higherCarrier: ExpectedCarrier = {
      ...r04.carrier,
      columns: r04.carrier.columns.map((column, index) =>
        index === higher.index ? { ...column, x: higher.value } : column,
      ),
      nodes: higherNodes,
      vertices: higherVertices,
      bounds: [
        Math.min(...higherVertices.map(([x]) => x)),
        Math.min(...higherVertices.map(([, y]) => y)),
        Math.max(...higherVertices.map(([x]) => x)),
        Math.max(...higherVertices.map(([, y]) => y)),
      ],
    };
    expect(() => assertEmbeddingCertificate(r04Row, r04, higherCarrier)).not.toThrow();
    const f01Row = rowFor('F01', 'nonzero');
    const f01Result = resultFor('F01', 'nonzero');
    const overBudgetNodes = f01.nodes.map((node) =>
      node.column === 0 ? { ...node, point: [1, node.point[1]] as const } : node,
    );
    const overBudgetVertices = [...f01.vertices];
    overBudgetNodes.forEach((node) => {
      if (node.vertex !== null) overBudgetVertices[node.vertex] = node.point;
    });
    const overBudgetCarrier: ExpectedCarrier = {
      ...f01,
      columns: [{ ...firstColumn, x: 1 }, ...f01.columns.slice(1)],
      nodes: overBudgetNodes,
      vertices: overBudgetVertices,
      bounds: [
        Math.min(...overBudgetVertices.map(([x]) => x)),
        Math.min(...overBudgetVertices.map(([, y]) => y)),
        Math.max(...overBudgetVertices.map(([x]) => x)),
        Math.max(...overBudgetVertices.map(([, y]) => y)),
      ],
    };
    const negativeZeroNodes = f01.nodes.map((node) =>
      node.column === 0 ? { ...node, point: [-0, node.point[1]] as const } : node,
    );
    const negativeZeroVertices = [...f01.vertices];
    negativeZeroNodes.forEach((node) => {
      if (node.vertex !== null) negativeZeroVertices[node.vertex] = node.point;
    });
    const negativeZeroCarrier: ExpectedCarrier = {
      ...f01,
      columns: [{ ...firstColumn, x: -0 }, ...f01.columns.slice(1)],
      nodes: negativeZeroNodes,
      vertices: negativeZeroVertices,
      bounds: [-0, f01.bounds[1], f01.bounds[2], f01.bounds[3]],
    };
    expect(() => assertEmbeddingCertificate(f01Row, f01Result, overBudgetCarrier)).toThrow(
      /scalar half-budget/u,
    );
    const internalSeam = (
      id: 'F07' | 'F11',
      fromPoint: readonly [number, number],
      toPoint: readonly [number, number],
      sourceIds: readonly [number, number],
    ): ExpectedCarrier => {
      const carrier = resultFor(id, 'nonzero').carrier;
      const findNode = ([x, y]: readonly [number, number]) =>
        required(carrier.nodes.findIndex((node) => node.point[0] === x && node.point[1] === y));
      const from = findNode(fromPoint);
      const to = findNode(toPoint);
      if (from < 0 || to < 0) throw new Error(`${id} seam nodes missing`);
      const start = carrier.contributors.length;
      return {
        ...carrier,
        contributors: [...carrier.contributors, ...sourceIds],
        boundaries: [
          ...carrier.boundaries,
          {
            from,
            to,
            kind: id === 'F07' ? 'Vertical' : 'Upper',
            sources: { start, count: 2 },
            before_winding: 1,
            after_winding: 1,
          },
        ],
      };
    };
    const f07Seam = internalSeam('F07', [2, 0], [2, 2], [1, 7]);
    const f11Seam = internalSeam('F11', [2, 4], [4, 4], [2, 4]);
    const cases: ReadonlyArray<readonly [string, ExpectedCarrier, RegExp]> = [
      [
        'reordered columns',
        { ...f01, columns: [secondColumn, firstColumn, ...f01.columns.slice(2)] },
        /column order|scalar half-budget/u,
      ],
      ['merged distinct nodes', { ...f01, nodes: f01.nodes.slice(1) }, /node topology count/u],
      [
        'moved exact pin',
        {
          ...f01,
          columns: [{ ...firstColumn, x: firstColumn.x + 1 }, ...f01.columns.slice(1)],
        },
        /scalar half-budget/u,
      ],
      ['higher greedy choice', higherCarrier, /canonical columns/u],
      ['over half budget', overBudgetCarrier, /scalar half-budget/u],
      ['negative zero output', negativeZeroCarrier, /normalize signed zero/u],
      [
        'broken shared vertex',
        {
          ...f01,
          nodes: [
            { ...firstNode, vertex: firstNode.vertex === null ? 0 : firstNode.vertex + 1 },
            ...f01.nodes.slice(1),
          ],
        },
        /canonical nodes/u,
      ],
      ['missing cell', { ...f01, cells: f01.cells.slice(1) }, /cell topology/u],
      ['extra cell', { ...f01, cells: [...f01.cells, firstCell] }, /cell topology/u],
      [
        'changed cell corner',
        {
          ...f01,
          cells: [
            {
              ...firstCell,
              nodes: [firstCell.nodes[1], ...firstCell.nodes.slice(1)] as [
                number,
                number,
                number,
                number,
              ],
            },
            ...f01.cells.slice(1),
          ],
        },
        /cell topology/u,
      ],
      ['missing triangle', { ...f01, indices: f01.indices.slice(3) }, /mesh connectivity/u],
      [
        'duplicate triangle',
        { ...f01, indices: [...f01.indices, ...f01.indices.slice(0, 3)] },
        /mesh connectivity/u,
      ],
      [
        'reversed triangle',
        {
          ...f01,
          indices: [i0, i2, i1, ...f01.indices.slice(3)],
        },
        /mesh connectivity/u,
      ],
      [
        'out of range index',
        { ...f01, indices: [f01.vertices.length, ...f01.indices.slice(1)] },
        /mesh connectivity/u,
      ],
      [
        'diagonal ledger atom',
        {
          ...f01,
          boundaries: [
            ...f01.boundaries,
            { ...firstBoundary, from: firstCell.nodes[0], to: firstCell.nodes[2] },
          ],
        },
        /boundary ledger/u,
      ],
      ['missing boundary', { ...f01, boundaries: f01.boundaries.slice(1) }, /boundary ledger/u],
      [
        'reversed boundary',
        {
          ...f01,
          boundaries: [
            { ...firstBoundary, from: firstBoundary.to, to: firstBoundary.from },
            ...f01.boundaries.slice(1),
          ],
        },
        /boundary ledger/u,
      ],
      ['retained F07 internal seam', f07Seam, /boundary ledger/u],
      ['retained F11 internal seam', f11Seam, /boundary ledger/u],
      [
        'incorrect source id',
        { ...f01, contributors: [f01.source_edges.length, ...f01.contributors.slice(1)] },
        /source attribution/u,
      ],
      [
        'wrong vertical transfer',
        {
          ...f01,
          spans: [
            { ...firstSpan, vertical_delta: firstSpan.vertical_delta + 1 },
            ...f01.spans.slice(1),
          ],
        },
        /vertical transfer/u,
      ],
      ['wrong F02 rule', f02Evenodd, /(canonical nodes|cell topology|boundary ledger)/u],
    ];
    for (const [label, candidate, message] of cases) {
      expect(() => {
        const expected =
          label === 'wrong F02 rule'
            ? resultFor('F02', 'nonzero')
            : label === 'higher greedy choice'
              ? r04
              : label.includes('F07')
                ? resultFor('F07', 'nonzero')
                : label.includes('F11')
                  ? resultFor('F11', 'nonzero')
                  : f01Result;
        const expectedRow =
          label === 'wrong F02 rule'
            ? rowFor('F02', 'nonzero')
            : label === 'higher greedy choice'
              ? r04Row
              : label.includes('F07')
                ? rowFor('F07', 'nonzero')
                : label.includes('F11')
                  ? rowFor('F11', 'nonzero')
                  : f01Row;
        verifyRoundedFillCarrier(expectedRow, expected, candidate);
      }, label).toThrow(message);
    }
  });

  it('rejects a stale source echo before carrier verification', () => {
    const row = required(rows[0]);
    const stale = row.contours.map((contour, index) => (index === 0 ? contour.slice(1) : contour));
    expect(() => assertSourceEcho(row, stale)).toThrow(/source echo mismatch/u);
    expect(() => assertSourceEcho(row, row.contours)).not.toThrow();
    const r05 = rowFor('R05', 'nonzero');
    expect(
      r05.contours.flat().some(([x, y]) => x === 0x8000000000000000n || y === 0x8000000000000000n),
    ).toBe(true);
    expect(() => assertSourceEcho(r05, r05.contours)).not.toThrow();
  });

  it('keeps all fixture coordinates finite and exact-decoded', () => {
    for (const row of rows) {
      expect(exactBits(row.tauBits).n).toBeGreaterThan(0n);
      for (const contour of row.contours) {
        for (const [x, y] of contour) {
          expect(() => [exactBits(x), exactBits(y)]).not.toThrow();
        }
      }
    }
  });

  it('rejects nonfinite coordinates and nonpositive tolerances at the fixture boundary', () => {
    const text = readFileSync(fixture, 'utf8');
    expect(() =>
      parseRoundedFillFixture(text.replace('0000000000000000,', '7ff0000000000000,')),
    ).toThrow(/must be finite/u);
    expect(() =>
      parseRoundedFillFixture(text.replace('0000000000000001 OK', '0000000000000000 OK')),
    ).toThrow(/tau must be positive/u);
  });

  it('strictly rejects malformed native row schemas before geometric verification', () => {
    const fixtureRow = rowFor('F01', 'nonzero');
    const carrier = resultFor('F01', 'nonzero').carrier;
    const base: Record<string, unknown> = {
      id: fixtureRow.id,
      rule: fixtureRow.rule,
      tau_bits: fixtureRow.tauBits.toString(16).padStart(16, '0'),
      profile: fixtureRow.profile,
      contours: fixtureRow.contours.map((contour) =>
        contour.map(([x, y]) => [fromBits(x), fromBits(y)]),
      ),
      error: null,
      output: carrier,
      stats: {
        input_vertices: 4,
        edges: 4,
        pair_checks: 6,
        events: 8,
        columns: carrier.columns.length,
        sections: carrier.sections.length,
        nodes: carrier.nodes.length,
        cells: carrier.cells.length,
        boundaries: carrier.boundaries.length,
        contributors: carrier.contributors.length,
        work_units: 1,
      },
    };
    expect(() => parseNativeRoundedRow(JSON.stringify(base), 0)).not.toThrow();

    const missing = structuredClone(base);
    delete missing.id;
    expect(() => parseNativeRoundedRow(JSON.stringify(missing), 0)).toThrow(/keys mismatch/u);
    expect(() => parseNativeRoundedRow(JSON.stringify({ ...base, extra: 1 }), 0)).toThrow(
      /keys mismatch/u,
    );

    const nested = structuredClone(base);
    const nestedOutput = nested.output as Record<string, unknown>;
    const nestedColumns = nestedOutput.columns as Array<Record<string, unknown>>;
    nestedColumns[0]!.x = 'invalid';
    expect(() => parseNativeRoundedRow(JSON.stringify(nested), 0)).toThrow(/must be finite/u);

    const nonfinite = JSON.stringify(base).replace(/"error_bound":[^,}]+/u, '"error_bound":1e999');
    expect(() => parseNativeRoundedRow(nonfinite, 0)).toThrow(/must be finite/u);
    expect(() =>
      parseNativeRoundedRow(
        JSON.stringify({ ...base, error: 'TopologyAmbiguous', output: carrier }),
        0,
      ),
    ).toThrow(/output\/error mismatch/u);
  });
});
