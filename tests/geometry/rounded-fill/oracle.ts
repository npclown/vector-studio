import {
  absolute,
  add,
  bitsOf,
  compare,
  div,
  exactBits,
  exactInteger,
  fromBits,
  half,
  mul,
  rational,
  sign,
  square,
  sub,
  ZERO,
  type Rational,
} from './exact.js';
import type {
  Boundary,
  Cell,
  Column,
  ColumnSpan,
  ExpectedCarrier,
  ExactPoint,
  FixtureRow,
  Node,
  OracleResult,
  Section,
  SourceEdge,
  SourceRange,
} from './types.js';

type Edge = Readonly<{
  source: SourceEdge;
  a: ExactPoint;
  b: ExactPoint;
  dySign: -1 | 1;
}>;
type ExactSection = Readonly<{ edge: number; endpoint: number; y: Rational }>;
type ExactNode = Readonly<{ column: number; y: Rational; sections: readonly ExactSection[] }>;
type ActiveGroup = Readonly<{ y: Rational; edges: readonly number[] }>;
type ExactCell = Readonly<{
  slab: number;
  nodes: readonly [number, number, number, number];
  lowerEdges: readonly number[];
  upperEdges: readonly number[];
  lowerBefore: number;
  lowerAfter: number;
  upperBefore: number;
  upperAfter: number;
}>;

const MIN_RANK = 0x0010000000000000n;
const MAX_RANK = 0xffeffffffffffffen;
const ZERO_RANK = 0x7fffffffffffffffn;
const SIGN_BIT = 0x8000000000000000n;

const isFilled = (winding: number, rule: FixtureRow['rule']) =>
  rule === 'nonzero' ? winding !== 0 : Math.abs(winding) % 2 === 1;

function point(bits: readonly [bigint, bigint]): ExactPoint {
  return { x: exactBits(bits[0]), y: exactBits(bits[1]) };
}

function cross(a: ExactPoint, b: ExactPoint, c: ExactPoint): Rational {
  return sub(mul(sub(b.x, a.x), sub(c.y, a.y)), mul(sub(b.y, a.y), sub(c.x, a.x)));
}

function properCrossingX(a: Edge, b: Edge): Rational | null {
  const o1 = sign(cross(a.a, a.b, b.a));
  const o2 = sign(cross(a.a, a.b, b.b));
  const o3 = sign(cross(b.a, b.b, a.a));
  const o4 = sign(cross(b.a, b.b, a.b));
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0 || o1 === o2 || o3 === o4) return null;
  const r = { x: sub(a.b.x, a.a.x), y: sub(a.b.y, a.a.y) };
  const s = { x: sub(b.b.x, b.a.x), y: sub(b.b.y, b.a.y) };
  const denominator = sub(mul(r.x, s.y), mul(r.y, s.x));
  const delta = { x: sub(b.a.x, a.a.x), y: sub(b.a.y, a.a.y) };
  const t = div(sub(mul(delta.x, s.y), mul(delta.y, s.x)), denominator);
  return add(a.a.x, mul(t, r.x));
}

function yAt(edge: Edge, x: Rational): Rational {
  return add(
    edge.a.y,
    div(mul(sub(edge.b.y, edge.a.y), sub(x, edge.a.x)), sub(edge.b.x, edge.a.x)),
  );
}

function betweenClosed(value: Rational, a: Rational, b: Rational): boolean {
  const low = compare(a, b) <= 0 ? a : b;
  const high = compare(a, b) <= 0 ? b : a;
  return compare(value, low) >= 0 && compare(value, high) <= 0;
}

function betweenOpen(value: Rational, a: Rational, b: Rational): boolean {
  const low = compare(a, b) <= 0 ? a : b;
  const high = compare(a, b) <= 0 ? b : a;
  return compare(value, low) > 0 && compare(value, high) < 0;
}

function uniqueSorted(values: readonly Rational[]): Rational[] {
  const sorted = [...values].sort(compare);
  return sorted.filter((value, index) => index === 0 || compare(value, sorted[index - 1]!) !== 0);
}

function sourceWinding(edges: readonly Edge[], x: Rational, y: Rational): number {
  let winding = 0;
  for (const edge of edges) {
    const ay = compare(edge.a.y, y);
    const by = compare(edge.b.y, y);
    const crossesUp = ay <= 0 && by > 0;
    const crossesDown = by <= 0 && ay > 0;
    if (!crossesUp && !crossesDown) continue;
    const intersection = add(
      edge.a.x,
      div(mul(sub(y, edge.a.y), sub(edge.b.x, edge.a.x)), sub(edge.b.y, edge.a.y)),
    );
    if (compare(intersection, x) > 0) winding += crossesUp ? 1 : -1;
  }
  return winding;
}

function sourceWindingSide(
  edges: readonly Edge[],
  x: Rational,
  y: Rational,
  side: 'left' | 'right',
): number {
  let winding = 0;
  for (const edge of edges) {
    const ay = compare(edge.a.y, y);
    const by = compare(edge.b.y, y);
    const crossesUp = ay <= 0 && by > 0;
    const crossesDown = by <= 0 && ay > 0;
    if (!crossesUp && !crossesDown) continue;
    const intersection = add(
      edge.a.x,
      div(mul(sub(y, edge.a.y), sub(edge.b.x, edge.a.x)), sub(edge.b.y, edge.a.y)),
    );
    const order = compare(intersection, x);
    if (order > 0 || (order === 0 && side === 'left')) winding += crossesUp ? 1 : -1;
  }
  return winding;
}

function rankBits(rank: bigint): bigint {
  return rank < ZERO_RANK ? BigInt.asUintN(64, ~rank) : (rank + 1n) ^ SIGN_BIT;
}

function bitsRank(bits: bigint): bigint {
  return (bits & SIGN_BIT) !== 0n ? BigInt.asUintN(64, ~bits) : (bits ^ SIGN_BIT) - 1n;
}

function rankValue(rank: bigint): bigint {
  return exactInteger(rankBits(rank));
}

function targetCompare(target: Rational, rank: bigint): -1 | 0 | 1 {
  return compare(target, rational(rankValue(rank)));
}

function findExactRank(target: Rational): bigint | null {
  let low = MIN_RANK;
  let high = MAX_RANK;
  while (low <= high) {
    const middle = low + ((high - low) >> 1n);
    const order = targetCompare(target, middle);
    if (order === 0) return middle;
    if (order < 0) high = middle - 1n;
    else low = middle + 1n;
  }
  return null;
}

function allowed(target: Rational, candidate: bigint, tolerance: bigint): boolean {
  return (
    2n *
      (target.n - candidate * target.d < 0n
        ? candidate * target.d - target.n
        : target.n - candidate * target.d) <=
    tolerance * target.d
  );
}

function window(target: Rational, tolerance: bigint): readonly [bigint, bigint] | null {
  const exact = findExactRank(target);
  if (exact !== null) return [exact, exact];
  let low = MIN_RANK;
  let high = MAX_RANK;
  while (low < high) {
    const middle = low + ((high - low) >> 1n);
    if (2n * (target.n - rankValue(middle) * target.d) <= tolerance * target.d) high = middle;
    else low = middle + 1n;
  }
  const lower = low;
  low = MIN_RANK;
  high = MAX_RANK;
  while (low < high) {
    const middle = low + ((high - low + 1n) >> 1n);
    if (2n * (rankValue(middle) * target.d - target.n) <= tolerance * target.d) low = middle;
    else high = middle - 1n;
  }
  const upper = low;
  return lower <= upper &&
    allowed(target, rankValue(lower), tolerance) &&
    allowed(target, rankValue(upper), tolerance)
    ? [lower, upper]
    : null;
}

function embed(values: readonly Rational[], tolerance: bigint): readonly number[] | null {
  const result: number[] = [];
  let previous: bigint | null = null;
  for (const value of values) {
    const interval = window(value, tolerance);
    if (!interval) return null;
    const selected: bigint =
      previous === null || interval[0] > previous ? interval[0] : previous + 1n;
    if (selected > interval[1]) return null;
    const number = fromBits(rankBits(selected));
    result.push(Object.is(number, -0) ? 0 : number);
    previous = selected;
  }
  return result;
}

function addRange(contributors: number[], values: readonly number[]): SourceRange {
  if (values.length === 0) return { start: 0, count: 0 };
  const start = contributors.length;
  contributors.push(...values);
  return { start, count: values.length };
}

function exactTriangleArea(a: ExactPoint, b: ExactPoint, c: ExactPoint): Rational {
  return half(cross(a, b, c));
}

export function buildRoundedFillOracle(row: FixtureRow): OracleResult {
  const edges: Edge[] = [];
  row.contours.forEach((contour, contourIndex) => {
    contour.forEach((bits, startVertex) => {
      const endVertex = (startVertex + 1) % contour.length;
      const a = point(bits);
      const b = point(contour[endVertex]!);
      if (compare(a.x, b.x) === 0 && compare(a.y, b.y) === 0) return;
      const dy = sign(sub(b.y, a.y));
      edges.push({
        source: { contour: contourIndex, start_vertex: startVertex, end_vertex: endVertex },
        a,
        b,
        dySign: dy === 0 ? 1 : dy,
      });
    });
  });

  const events = edges.flatMap((edge) => [edge.a.x, edge.b.x]);
  let properCrossings = 0;
  for (let left = 0; left < edges.length; left += 1) {
    for (let right = left + 1; right < edges.length; right += 1) {
      const crossing = properCrossingX(edges[left]!, edges[right]!);
      if (crossing) {
        events.push(crossing);
        properCrossings += 1;
      }
    }
  }
  const exactColumns = uniqueSorted(events);
  const exactNodes: ExactNode[] = [];
  const sectionRows: Array<{ column: number; node: number; edge: number; endpoint: number }> = [];
  const edgeNode = new Map<string, number>();

  exactColumns.forEach((x, column) => {
    const raw: ExactSection[] = [];
    edges.forEach((edge, edgeIndex) => {
      if (compare(edge.a.x, edge.b.x) === 0) {
        if (compare(x, edge.a.x) === 0) {
          raw.push({ edge: edgeIndex, endpoint: 1, y: edge.a.y });
          raw.push({ edge: edgeIndex, endpoint: 2, y: edge.b.y });
        }
      } else if (betweenClosed(x, edge.a.x, edge.b.x)) {
        raw.push({ edge: edgeIndex, endpoint: 0, y: yAt(edge, x) });
      }
    });
    raw.sort((a, b) => compare(a.y, b.y) || a.edge - b.edge || a.endpoint - b.endpoint);
    let position = 0;
    while (position < raw.length) {
      let end = position + 1;
      while (end < raw.length && compare(raw[position]!.y, raw[end]!.y) === 0) end += 1;
      const node = exactNodes.length;
      const grouped = raw.slice(position, end);
      exactNodes.push({ column, y: raw[position]!.y, sections: grouped });
      for (const section of grouped) {
        sectionRows.push({ column, node, edge: section.edge, endpoint: section.endpoint });
        const key = `${column}:${section.edge}`;
        if (!edgeNode.has(key)) edgeNode.set(key, node);
      }
      position = end;
    }
  });

  const exactCells: ExactCell[] = [];
  let exactArea = ZERO;
  for (let slab = 0; slab + 1 < exactColumns.length; slab += 1) {
    const leftColumn = exactColumns[slab]!;
    const rightColumn = exactColumns[slab + 1]!;
    const sampleX = rational(leftColumn.n + rightColumn.n, leftColumn.d + rightColumn.d);
    const active: ActiveGroup[] = [];
    const raw = edges
      .map((edge, edgeIndex) => ({ edge, edgeIndex }))
      .filter(
        ({ edge }) => compare(edge.a.x, edge.b.x) !== 0 && betweenOpen(sampleX, edge.a.x, edge.b.x),
      )
      .map(({ edge, edgeIndex }) => ({ edge: edgeIndex, y: yAt(edge, sampleX) }))
      .sort((a, b) => compare(a.y, b.y) || a.edge - b.edge);
    for (let position = 0; position < raw.length;) {
      let end = position + 1;
      while (end < raw.length && compare(raw[position]!.y, raw[end]!.y) === 0) end += 1;
      active.push({ y: raw[position]!.y, edges: raw.slice(position, end).map(({ edge }) => edge) });
      position = end;
    }
    const bandWinding = Array.from({ length: Math.max(0, active.length - 1) }, (_, band) =>
      sourceWinding(edges, sampleX, half(add(active[band]!.y, active[band + 1]!.y))),
    );
    for (let band = 0; band < bandWinding.length;) {
      if (!isFilled(bandWinding[band]!, row.rule)) {
        band += 1;
        continue;
      }
      let last = band;
      while (last + 1 < bandWinding.length && isFilled(bandWinding[last + 1]!, row.rule)) last += 1;
      const lower = active[band]!;
      const upper = active[last + 1]!;
      const leftLower = edgeNode.get(`${slab}:${lower.edges[0]!}`);
      const rightLower = edgeNode.get(`${slab + 1}:${lower.edges[0]!}`);
      const rightUpper = edgeNode.get(`${slab + 1}:${upper.edges[0]!}`);
      const leftUpper = edgeNode.get(`${slab}:${upper.edges[0]!}`);
      if ([leftLower, rightLower, rightUpper, leftUpper].some((node) => node === undefined)) {
        throw new Error(`${row.id}:${row.rule} unresolved cell node`);
      }
      const below = band === 0 ? 0 : bandWinding[band - 1]!;
      const above = last + 1 >= bandWinding.length ? 0 : bandWinding[last + 1]!;
      const cell: ExactCell = {
        slab,
        nodes: [leftLower!, rightLower!, rightUpper!, leftUpper!],
        lowerEdges: lower.edges,
        upperEdges: upper.edges,
        lowerBefore: below,
        lowerAfter: bandWinding[band]!,
        upperBefore: bandWinding[last]!,
        upperAfter: above,
      };
      exactCells.push(cell);
      const exactPointFor = (node: number): ExactPoint => ({
        x: exactColumns[exactNodes[node]!.column]!,
        y: exactNodes[node]!.y,
      });
      const bl = exactPointFor(cell.nodes[0]);
      const br = exactPointFor(cell.nodes[1]);
      const tr = exactPointFor(cell.nodes[2]);
      const tl = exactPointFor(cell.nodes[3]);
      exactArea = add(exactArea, add(exactTriangleArea(bl, br, tr), exactTriangleArea(bl, tr, tl)));
      band = last + 1;
    }
  }

  const tolerance = exactInteger(row.tauBits);
  const roundedX = embed(exactColumns, tolerance);
  if (!roundedX) return { ok: false, reason: 'x monotone pin/window assignment is infeasible' };
  const roundedY: number[] = Array<number>(exactNodes.length).fill(0);
  for (let column = 0; column < exactColumns.length; column += 1) {
    const indexes = exactNodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.column === column);
    const embedded = embed(
      indexes.map(({ node }) => node.y),
      tolerance,
    );
    if (!embedded)
      return {
        ok: false,
        reason: `column ${column} y monotone pin/window assignment is infeasible`,
      };
    embedded.forEach((value, position) => {
      roundedY[indexes[position]!.index] = value;
    });
  }

  const used = new Set(exactCells.flatMap((cell) => [...cell.nodes]));
  const vertexByNode = new Map<number, number>();
  const vertices: Array<readonly [number, number]> = [];
  exactNodes.forEach((node, index) => {
    if (!used.has(index)) return;
    vertexByNode.set(index, vertices.length);
    vertices.push([roundedX[node.column]!, roundedY[index]!]);
  });
  const nodes: Node[] = exactNodes.map((node, index) => ({
    point: [roundedX[node.column]!, roundedY[index]!],
    column: node.column,
    vertex: vertexByNode.get(index) ?? null,
  }));
  const columns: Column[] = exactColumns.map((_, column) => {
    const indexes = exactNodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.column === column);
    return {
      x: roundedX[column]!,
      node_start: indexes[0]?.index ?? exactNodes.length,
      node_count: indexes.length,
    };
  });
  const sections: Section[] = sectionRows;
  const contributors: number[] = [];
  const cells: Cell[] = exactCells.map((cell) => ({
    slab: cell.slab,
    nodes: cell.nodes,
    lower_sources: addRange(contributors, cell.lowerEdges),
    upper_sources: addRange(contributors, cell.upperEdges),
    lower_before: cell.lowerBefore,
    lower_after: cell.lowerAfter,
    upper_before: cell.upperBefore,
    upper_after: cell.upperAfter,
  }));
  const boundaries: Boundary[] = [];
  cells.forEach((cell) => {
    boundaries.push({
      from: cell.nodes[0],
      to: cell.nodes[1],
      kind: 'Lower',
      sources: cell.lower_sources,
      before_winding: cell.lower_before,
      after_winding: cell.lower_after,
    });
    boundaries.push({
      from: cell.nodes[2],
      to: cell.nodes[3],
      kind: 'Upper',
      sources: cell.upper_sources,
      before_winding: cell.upper_before,
      after_winding: cell.upper_after,
    });
  });
  const spans: ColumnSpan[] = [];
  exactColumns.forEach((x, column) => {
    const indexes = exactNodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.column === column);
    for (let position = 0; position + 1 < indexes.length; position += 1) {
      const lower = indexes[position]!;
      const upper = indexes[position + 1]!;
      const sampleY = half(add(lower.node.y, upper.node.y));
      const vertical = edges
        .map((edge, index) => ({ edge, index }))
        .filter(
          ({ edge }) =>
            compare(edge.a.x, edge.b.x) === 0 &&
            compare(edge.a.x, x) === 0 &&
            betweenOpen(sampleY, edge.a.y, edge.b.y),
        );
      const delta = vertical.reduce((sum, { edge }) => sum + edge.dySign, 0);
      const right = sourceWindingSide(edges, x, sampleY, 'right');
      const left = sourceWindingSide(edges, x, sampleY, 'left');
      if (right !== left - delta)
        throw new Error(`${row.id}:${row.rule} vertical transfer mismatch`);
      const range = addRange(
        contributors,
        vertical.map(({ index }) => index),
      );
      const span: ColumnSpan = {
        column,
        lower: lower.index,
        upper: upper.index,
        left_winding: left,
        right_winding: right,
        vertical_delta: delta,
        vertical_sources: range,
      };
      spans.push(span);
      const leftFilled = isFilled(left, row.rule);
      const rightFilled = isFilled(right, row.rule);
      if (leftFilled !== rightFilled) {
        boundaries.push({
          from: leftFilled ? lower.index : upper.index,
          to: leftFilled ? upper.index : lower.index,
          kind: 'Vertical',
          sources: range,
          before_winding: left,
          after_winding: right,
        });
      }
    }
  });
  const indices: number[] = [];
  exactCells.forEach((cell) => {
    const [bl, br, tr, tl] = cell.nodes;
    if (br !== tr)
      indices.push(vertexByNode.get(bl)!, vertexByNode.get(br)!, vertexByNode.get(tr)!);
    if (bl !== tl)
      indices.push(vertexByNode.get(bl)!, vertexByNode.get(tr)!, vertexByNode.get(tl)!);
  });
  for (let index = 0; index < indices.length; index += 3) {
    const a = vertices[indices[index]!]!;
    const b = vertices[indices[index + 1]!]!;
    const c = vertices[indices[index + 2]!]!;
    const exactA = {
      x: rational(exactInteger(bitsOf(a[0]))),
      y: rational(exactInteger(bitsOf(a[1]))),
    };
    const exactB = {
      x: rational(exactInteger(bitsOf(b[0]))),
      y: rational(exactInteger(bitsOf(b[1]))),
    };
    const exactC = {
      x: rational(exactInteger(bitsOf(c[0]))),
      y: rational(exactInteger(bitsOf(c[1]))),
    };
    if (sign(cross(exactA, exactB, exactC)) <= 0)
      throw new Error(`${row.id}:${row.rule} rounded triangle is not positive`);
  }
  const bounds: readonly [number, number, number, number] =
    vertices.length === 0
      ? [0, 0, 0, 0]
      : [
          Math.min(...vertices.map(([x]) => x)),
          Math.min(...vertices.map(([, y]) => y)),
          Math.max(...vertices.map(([x]) => x)),
          Math.max(...vertices.map(([, y]) => y)),
        ];
  const carrier: ExpectedCarrier = {
    vertices,
    indices,
    bounds,
    source_edges: edges.map(({ source }) => source),
    columns,
    nodes,
    sections,
    cells,
    boundaries,
    spans,
    contributors,
    error_bound: vertices.length === 0 ? 0 : fromBits(row.tauBits),
  };
  verifyCarrierInvariants(carrier);
  verifyEmbedding(
    row,
    carrier,
    exactColumns,
    exactNodes.map(({ y }) => y),
  );
  if (sign(exactArea) < 0) throw new Error(`${row.id}:${row.rule} exact cell area is negative`);
  return {
    ok: true,
    carrier,
    exactArea,
    exactColumns,
    exactNodeY: exactNodes.map(({ y }) => y),
    rawEvents: events.length,
    properCrossings,
  };
}

const PROFILE_TIMES_32 = {
  I: [
    [32, 0],
    [0, 32],
  ],
  R16: [
    [0, -512],
    [512, 0],
  ],
  D32: [
    [1024, 0],
    [0, 1],
  ],
  S192: [
    [6144, 3072],
    [0, 6144],
  ],
} as const;
const PROFILE_UPPER = { I: 1n, R16: 16n, D32: 32n, S192: 480n } as const;

function verifyEmbedding(
  row: FixtureRow,
  carrier: ExpectedCarrier,
  xs: readonly Rational[],
  ys: readonly Rational[],
): void {
  const tau = exactInteger(row.tauBits);
  const unit = 1n << 1074n;
  if (PROFILE_UPPER[row.profile] * tau * 16n > unit)
    throw new Error('profile and tolerance exceed the physical allocation');
  carrier.columns.forEach((column, index) => {
    if (!allowed(xs[index]!, exactInteger(bitsOf(column.x)), tau))
      throw new Error('column exceeds scalar half-budget');
    if (index > 0 && !(carrier.columns[index - 1]!.x < column.x))
      throw new Error('column order is not strict');
  });
  const matrix = PROFILE_TIMES_32[row.profile];
  carrier.nodes.forEach((node, index) => {
    const exactX = xs[node.column]!;
    const dx = sub(rational(exactInteger(bitsOf(node.point[0]))), exactX);
    const dy = sub(rational(exactInteger(bitsOf(node.point[1]))), ys[index]!);
    if (!allowed(ys[index]!, exactInteger(bitsOf(node.point[1])), tau))
      throw new Error('node exceeds scalar half-budget');
    if (compare(add(absolute(dx), absolute(dy)), rational(tau)) > 0)
      throw new Error('node exceeds local L1 budget');
    const screenX = add(
      mul(rational(BigInt(matrix[0][0])), dx),
      mul(rational(BigInt(matrix[0][1])), dy),
    );
    const screenY = add(
      mul(rational(BigInt(matrix[1][0])), dx),
      mul(rational(BigInt(matrix[1][1])), dy),
    );
    const norm = div(add(square(screenX), square(screenY)), rational(32n * 32n));
    if (compare(norm, rational(unit * unit, 256n)) > 0)
      throw new Error('node exceeds physical profile budget');
  });
}

function verifyCarrierInvariants(carrier: ExpectedCarrier): void {
  const ranges = [
    ...carrier.cells.flatMap((cell) => [cell.lower_sources, cell.upper_sources]),
    ...carrier.spans.map((span) => span.vertical_sources),
    ...carrier.boundaries.map((boundary) => boundary.sources),
  ];
  for (const range of ranges) {
    if (range.count === 0 && range.start !== 0) throw new Error('empty range is not canonical');
    const values =
      range.count === 0 ? [] : carrier.contributors.slice(range.start, range.start + range.count);
    if (values.length !== range.count) throw new Error('contributor range is out of bounds');
    if (values.some((value) => value < 0 || value >= carrier.source_edges.length))
      throw new Error('contributor source is out of bounds');
    if (values.some((value, index) => index > 0 && values[index - 1]! >= value))
      throw new Error('contributor range is not source ordered');
  }
  const balance = Array<number>(carrier.nodes.length).fill(0);
  for (const boundary of carrier.boundaries) {
    if (!carrier.nodes[boundary.from] || !carrier.nodes[boundary.to])
      throw new Error('boundary node is out of bounds');
    balance[boundary.from] = balance[boundary.from]! + 1;
    balance[boundary.to] = balance[boundary.to]! - 1;
  }
  if (balance.some((value) => value !== 0))
    throw new Error('directed boundary incidence is unbalanced');
}

export function assertCarrierMatches(expected: ExpectedCarrier, actual: ExpectedCarrier): void {
  const fields = [
    'source_edges',
    'columns',
    'nodes',
    'sections',
    'cells',
    'boundaries',
    'spans',
    'contributors',
    'vertices',
    'indices',
    'bounds',
    'error_bound',
  ] as const;
  for (const field of fields) {
    if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`${field} mismatch`);
    }
  }
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function expandedRange(carrier: ExpectedCarrier, range: SourceRange): readonly number[] {
  if (range.count === 0) {
    if (range.start !== 0) throw new Error('empty contributor range is not canonical');
    return [];
  }
  const values = carrier.contributors.slice(range.start, range.start + range.count);
  if (values.length !== range.count) throw new Error('contributor range is out of bounds');
  return values;
}

export function verifyRoundedFillCarrier(
  row: FixtureRow,
  expected: Exclude<OracleResult, { ok: false }>,
  actual: ExpectedCarrier,
): void {
  const outputScalars = [
    ...actual.columns.map(({ x }) => x),
    ...actual.nodes.flatMap(({ point }) => point),
    ...actual.vertices.flatMap((point) => point),
    ...actual.bounds,
    actual.error_bound,
  ];
  if (outputScalars.some((value) => Object.is(value, -0)))
    throw new Error('rounded output must normalize signed zero');
  if (actual.columns.length !== expected.carrier.columns.length)
    throw new Error('column topology count mismatch');
  if (actual.nodes.length !== expected.carrier.nodes.length)
    throw new Error('node topology count mismatch');
  assertEmbeddingCertificate(row, expected, actual);
  if (!same(actual.source_edges, expected.carrier.source_edges))
    throw new Error('source edge mapping mismatch');
  if (!same(actual.columns, expected.carrier.columns))
    throw new Error('canonical columns mismatch');
  if (!same(actual.nodes, expected.carrier.nodes))
    throw new Error('canonical nodes/vertices mismatch');
  if (!same(actual.sections, expected.carrier.sections))
    throw new Error('section topology mismatch');

  const normalizeCells = (carrier: ExpectedCarrier) =>
    carrier.cells.map((cell) => ({
      ...cell,
      lower_sources: expandedRange(carrier, cell.lower_sources),
      upper_sources: expandedRange(carrier, cell.upper_sources),
    }));
  if (!same(normalizeCells(actual), normalizeCells(expected.carrier)))
    throw new Error('cell topology or source attribution mismatch');

  for (const span of actual.spans) {
    if (span.right_winding !== span.left_winding - span.vertical_delta)
      throw new Error('vertical transfer mismatch');
  }
  const normalizeSpans = (carrier: ExpectedCarrier) =>
    carrier.spans.map((span) => ({
      ...span,
      vertical_sources: expandedRange(carrier, span.vertical_sources),
    }));
  if (!same(normalizeSpans(actual), normalizeSpans(expected.carrier)))
    throw new Error('column span or vertical source attribution mismatch');

  const normalizeBoundaries = (carrier: ExpectedCarrier) =>
    carrier.boundaries.map((boundary) => ({
      ...boundary,
      sources: expandedRange(carrier, boundary.sources),
    }));
  if (!same(normalizeBoundaries(actual), normalizeBoundaries(expected.carrier)))
    throw new Error('resolved boundary ledger mismatch');

  if (!same(actual.contributors, expected.carrier.contributors))
    throw new Error('canonical contributor storage mismatch');
  if (
    !same(actual.vertices, expected.carrier.vertices) ||
    !same(actual.indices, expected.carrier.indices)
  )
    throw new Error('mesh connectivity mismatch');
  if (!same(actual.bounds, expected.carrier.bounds)) throw new Error('mesh bounds mismatch');
  if (actual.error_bound !== expected.carrier.error_bound)
    throw new Error('error certificate mismatch');
  verifyCarrierInvariants(actual);
}

export function assertEmbeddingCertificate(
  row: FixtureRow,
  result: Exclude<OracleResult, { ok: false }>,
  carrier: ExpectedCarrier,
): void {
  verifyEmbedding(row, carrier, result.exactColumns, result.exactNodeY);
}

export function structuralCounts(result: Exclude<OracleResult, { ok: false }>): Readonly<{
  columns: number;
  nodes: number;
  cells: number;
  triangles: number;
}> {
  return {
    columns: result.carrier.columns.length,
    nodes: result.carrier.nodes.length,
    cells: result.carrier.cells.length,
    triangles: result.carrier.indices.length / 3,
  };
}

export function countMovableColumns(result: Exclude<OracleResult, { ok: false }>): number {
  return result.exactColumns.filter((column) => findExactRank(column) === null).length;
}

export function countColumnsOutsideNearestBracket(
  result: Exclude<OracleResult, { ok: false }>,
): number {
  let count = 0;
  result.exactColumns.forEach((target, index) => {
    if (findExactRank(target) !== null) return;
    let low = MIN_RANK;
    let high = MAX_RANK;
    while (low < high) {
      const middle = low + ((high - low) >> 1n);
      if (targetCompare(target, middle) <= 0) high = middle;
      else low = middle + 1n;
    }
    const ceiling = low;
    const floor = ceiling - 1n;
    const selected = bitsRank(bitsOf(result.carrier.columns[index]!.x));
    if (selected !== floor && selected !== ceiling) count += 1;
  });
  return count;
}

export function nextAdmissibleColumn(
  row: FixtureRow,
  result: Exclude<OracleResult, { ok: false }>,
): Readonly<{ index: number; value: number }> | null {
  const tolerance = exactInteger(row.tauBits);
  for (let index = 0; index < result.exactColumns.length; index += 1) {
    const target = result.exactColumns[index]!;
    if (findExactRank(target) !== null) continue;
    const interval = window(target, tolerance);
    if (!interval) continue;
    const selected = bitsRank(bitsOf(result.carrier.columns[index]!.x));
    const next = selected + 1n;
    const following = result.carrier.columns[index + 1];
    if (next <= interval[1] && (!following || next < bitsRank(bitsOf(following.x)))) {
      return { index, value: fromBits(rankBits(next)) };
    }
  }
  return null;
}

export function assertSourceEcho(row: FixtureRow, contours: FixtureRow['contours']): void {
  const encode = (value: FixtureRow['contours']) =>
    value.map((contour) => contour.map(([x, y]) => [x.toString(16), y.toString(16)]));
  if (JSON.stringify(encode(row.contours)) !== JSON.stringify(encode(contours))) {
    throw new Error('source echo mismatch');
  }
}
