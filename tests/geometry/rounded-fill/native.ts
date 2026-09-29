import type {
  Boundary,
  BoundaryKind,
  Cell,
  Column,
  ColumnSpan,
  ExpectedCarrier,
  FillRule,
  Node,
  Point,
  ProfileName,
  Section,
  SourceEdge,
  SourceRange,
} from './types.js';

export type RoundedFillStats = Readonly<{
  input_vertices: number;
  edges: number;
  pair_checks: number;
  events: number;
  columns: number;
  sections: number;
  nodes: number;
  cells: number;
  boundaries: number;
  contributors: number;
  work_units: number;
}>;

export type NativeRoundedRow = Readonly<{
  id: string;
  rule: FillRule;
  tau_bits: string;
  profile: ProfileName;
  contours: readonly (readonly Point[])[];
  error: 'TopologyAmbiguous' | null;
  output: ExpectedCarrier | null;
  stats: RoundedFillStats;
}>;

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} keys mismatch`);
  return result;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${label} must be finite`);
  return value;
}

function integer(value: unknown, label: string): number {
  const result = finite(value, label);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`${label} must be a nonnegative integer`);
  return result;
}

function signedInteger(value: unknown, label: string): number {
  const result = finite(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function point(value: unknown, label: string): Point {
  const items = array(value, label);
  if (items.length !== 2) throw new Error(`${label} must contain two coordinates`);
  return [finite(items[0], `${label}[0]`), finite(items[1], `${label}[1]`)];
}

function range(value: unknown, label: string): SourceRange {
  const item = record(value, label, ['start', 'count']);
  return {
    start: integer(item.start, `${label}.start`),
    count: integer(item.count, `${label}.count`),
  };
}

function parseOutput(value: unknown, label: string): ExpectedCarrier {
  const item = record(value, label, [
    'vertices',
    'indices',
    'bounds',
    'source_edges',
    'columns',
    'nodes',
    'sections',
    'cells',
    'boundaries',
    'spans',
    'contributors',
    'error_bound',
  ]);
  const vertices = array(item.vertices, `${label}.vertices`).map((entry, index) =>
    point(entry, `${label}.vertices[${index}]`),
  );
  const indices = array(item.indices, `${label}.indices`).map((entry, index) =>
    integer(entry, `${label}.indices[${index}]`),
  );
  const boundsRaw = array(item.bounds, `${label}.bounds`);
  if (boundsRaw.length !== 4) throw new Error(`${label}.bounds must contain four coordinates`);
  const bounds = boundsRaw.map((entry, index) => finite(entry, `${label}.bounds[${index}]`)) as [
    number,
    number,
    number,
    number,
  ];
  const source_edges: SourceEdge[] = array(item.source_edges, `${label}.source_edges`).map(
    (entry, index) => {
      const source = record(entry, `${label}.source_edges[${index}]`, [
        'contour',
        'start_vertex',
        'end_vertex',
      ]);
      return {
        contour: integer(source.contour, `${label}.source_edges[${index}].contour`),
        start_vertex: integer(source.start_vertex, `${label}.source_edges[${index}].start_vertex`),
        end_vertex: integer(source.end_vertex, `${label}.source_edges[${index}].end_vertex`),
      };
    },
  );
  const columns: Column[] = array(item.columns, `${label}.columns`).map((entry, index) => {
    const column = record(entry, `${label}.columns[${index}]`, ['x', 'node_start', 'node_count']);
    return {
      x: finite(column.x, `${label}.columns[${index}].x`),
      node_start: integer(column.node_start, `${label}.columns[${index}].node_start`),
      node_count: integer(column.node_count, `${label}.columns[${index}].node_count`),
    };
  });
  const nodes: Node[] = array(item.nodes, `${label}.nodes`).map((entry, index) => {
    const node = record(entry, `${label}.nodes[${index}]`, ['point', 'column', 'vertex']);
    return {
      point: point(node.point, `${label}.nodes[${index}].point`),
      column: integer(node.column, `${label}.nodes[${index}].column`),
      vertex: node.vertex === null ? null : integer(node.vertex, `${label}.nodes[${index}].vertex`),
    };
  });
  const sections: Section[] = array(item.sections, `${label}.sections`).map((entry, index) => {
    const section = record(entry, `${label}.sections[${index}]`, [
      'column',
      'node',
      'edge',
      'endpoint',
    ]);
    return {
      column: integer(section.column, `${label}.sections[${index}].column`),
      node: integer(section.node, `${label}.sections[${index}].node`),
      edge: integer(section.edge, `${label}.sections[${index}].edge`),
      endpoint: integer(section.endpoint, `${label}.sections[${index}].endpoint`),
    };
  });
  const cells: Cell[] = array(item.cells, `${label}.cells`).map((entry, index) => {
    const cell = record(entry, `${label}.cells[${index}]`, [
      'slab',
      'nodes',
      'lower_sources',
      'upper_sources',
      'lower_before',
      'lower_after',
      'upper_before',
      'upper_after',
    ]);
    const cellNodes = array(cell.nodes, `${label}.cells[${index}].nodes`);
    if (cellNodes.length !== 4) throw new Error(`${label}.cells[${index}].nodes length`);
    return {
      slab: integer(cell.slab, `${label}.cells[${index}].slab`),
      nodes: cellNodes.map((node, nodeIndex) =>
        integer(node, `${label}.cells[${index}].nodes[${nodeIndex}]`),
      ) as [number, number, number, number],
      lower_sources: range(cell.lower_sources, `${label}.cells[${index}].lower_sources`),
      upper_sources: range(cell.upper_sources, `${label}.cells[${index}].upper_sources`),
      lower_before: signedInteger(cell.lower_before, `${label}.cells[${index}].lower_before`),
      lower_after: signedInteger(cell.lower_after, `${label}.cells[${index}].lower_after`),
      upper_before: signedInteger(cell.upper_before, `${label}.cells[${index}].upper_before`),
      upper_after: signedInteger(cell.upper_after, `${label}.cells[${index}].upper_after`),
    };
  });
  const boundaries: Boundary[] = array(item.boundaries, `${label}.boundaries`).map(
    (entry, index) => {
      const boundary = record(entry, `${label}.boundaries[${index}]`, [
        'from',
        'to',
        'kind',
        'sources',
        'before_winding',
        'after_winding',
      ]);
      if (!['Lower', 'Upper', 'Vertical'].includes(boundary.kind as string))
        throw new Error(`${label}.boundaries[${index}].kind invalid`);
      return {
        from: integer(boundary.from, `${label}.boundaries[${index}].from`),
        to: integer(boundary.to, `${label}.boundaries[${index}].to`),
        kind: boundary.kind as BoundaryKind,
        sources: range(boundary.sources, `${label}.boundaries[${index}].sources`),
        before_winding: signedInteger(
          boundary.before_winding,
          `${label}.boundaries[${index}].before_winding`,
        ),
        after_winding: signedInteger(
          boundary.after_winding,
          `${label}.boundaries[${index}].after_winding`,
        ),
      };
    },
  );
  const spans: ColumnSpan[] = array(item.spans, `${label}.spans`).map((entry, index) => {
    const span = record(entry, `${label}.spans[${index}]`, [
      'column',
      'lower',
      'upper',
      'left_winding',
      'right_winding',
      'vertical_delta',
      'vertical_sources',
    ]);
    return {
      column: integer(span.column, `${label}.spans[${index}].column`),
      lower: integer(span.lower, `${label}.spans[${index}].lower`),
      upper: integer(span.upper, `${label}.spans[${index}].upper`),
      left_winding: signedInteger(span.left_winding, `${label}.spans[${index}].left_winding`),
      right_winding: signedInteger(span.right_winding, `${label}.spans[${index}].right_winding`),
      vertical_delta: signedInteger(span.vertical_delta, `${label}.spans[${index}].vertical_delta`),
      vertical_sources: range(span.vertical_sources, `${label}.spans[${index}].vertical_sources`),
    };
  });
  const contributors = array(item.contributors, `${label}.contributors`).map((entry, index) =>
    integer(entry, `${label}.contributors[${index}]`),
  );
  return {
    vertices,
    indices,
    bounds,
    source_edges,
    columns,
    nodes,
    sections,
    cells,
    boundaries,
    spans,
    contributors,
    error_bound: finite(item.error_bound, `${label}.error_bound`),
  };
}

export function parseNativeRoundedRow(line: string, index: number): NativeRoundedRow {
  const item = record(JSON.parse(line) as unknown, `row ${index}`, [
    'id',
    'rule',
    'tau_bits',
    'profile',
    'contours',
    'error',
    'output',
    'stats',
  ]);
  const rule = string(item.rule, `row ${index}.rule`);
  if (rule !== 'nonzero' && rule !== 'evenodd') throw new Error(`row ${index}.rule invalid`);
  const profile = string(item.profile, `row ${index}.profile`);
  if (!['I', 'R16', 'D32', 'S192'].includes(profile))
    throw new Error(`row ${index}.profile invalid`);
  const tauBits = string(item.tau_bits, `row ${index}.tau_bits`);
  if (!/^[0-9a-f]{16}$/u.test(tauBits)) throw new Error(`row ${index}.tau_bits invalid`);
  const contours = array(item.contours, `row ${index}.contours`).map((contour, contourIndex) =>
    array(contour, `row ${index}.contours[${contourIndex}]`).map((entry, pointIndex) =>
      point(entry, `row ${index}.contours[${contourIndex}][${pointIndex}]`),
    ),
  );
  if (item.error !== null && item.error !== 'TopologyAmbiguous')
    throw new Error(`row ${index}.error invalid`);
  if ((item.error === null) !== (item.output !== null))
    throw new Error(`row ${index} output/error mismatch`);
  const statsRecord = record(item.stats, `row ${index}.stats`, [
    'input_vertices',
    'edges',
    'pair_checks',
    'events',
    'columns',
    'sections',
    'nodes',
    'cells',
    'boundaries',
    'contributors',
    'work_units',
  ]);
  const stats = Object.fromEntries(
    Object.keys(statsRecord).map((key) => [
      key,
      integer(statsRecord[key], `row ${index}.stats.${key}`),
    ]),
  ) as RoundedFillStats;
  return {
    id: string(item.id, `row ${index}.id`),
    rule,
    tau_bits: tauBits,
    profile: profile as ProfileName,
    contours,
    error: item.error,
    output: item.output === null ? null : parseOutput(item.output, `row ${index}.output`),
    stats,
  };
}
