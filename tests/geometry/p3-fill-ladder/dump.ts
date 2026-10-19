/**
 * P3 Alt-A1 unit AL-U2 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` section 4.2): the strict
 * reader of the `emit_fill_ladder_dump` hand-off, schema `p3-fill-ladder-dump/1`. The view,
 * owner, source and mesh fields have the shapes of the spike hand-off
 * (`p3-b0-spike-fixtures/1`), so the spike's oracles read them unchanged.
 */
import type {
  FillRule,
  HexPoint,
  SpikeMesh,
  SpikeOwner,
  SpikeSource,
  SpikeView,
} from '../p3-b0-spike/oracle.js';

export const DUMP_SCHEMA = 'p3-fill-ladder-dump/1';
export const DUMP_BEGIN = 'P3_FILL_LADDER_DUMP_BEGIN';
export const DUMP_END = 'P3_FILL_LADDER_DUMP_END';

/** Section 3.1's fallback reasons, in stage order: the spike's, between `RANGE` and `MESH_CHECK`. */
export type LadderReason =
  | 'RANGE'
  | 'PREFIX'
  | 'STRUCTURE'
  | 'DEVIATION'
  | 'CLOSURE'
  | 'MONOTONE'
  | 'CROSSING'
  | 'CLEARANCE'
  | 'TRIANGLE'
  | 'MESH_CHECK';
export const LADDER_REASONS: readonly LadderReason[] = [
  'RANGE',
  'PREFIX',
  'STRUCTURE',
  'DEVIATION',
  'CLOSURE',
  'MONOTONE',
  'CROSSING',
  'CLEARANCE',
  'TRIANGLE',
  'MESH_CHECK',
];
/** Section 3.1's stages: AL-FR0, the spike's S1 and FR1-FR8, then AL-FR9. */
export type LadderStage =
  'Fr0' | 'S1' | 'Fr1' | 'Fr2' | 'Fr3' | 'Fr4' | 'Fr5' | 'Fr6' | 'Fr7' | 'Fr8' | 'Fr9';
export const LADDER_STAGES: readonly LadderStage[] = [
  'Fr0',
  'S1',
  'Fr1',
  'Fr2',
  'Fr3',
  'Fr4',
  'Fr5',
  'Fr6',
  'Fr7',
  'Fr8',
  'Fr9',
];

export type Pair = readonly [number, number];
export type Triangle = readonly [number, number, number];

export type LadderSpike = Readonly<{
  rung: 'fast' | 'fallback';
  reason: string | null;
  /** Both fast with the same vertex bits and triangles. */
  sameMesh: boolean;
  /** The spike's rung 0 passes FR1-FR3 on the same input. */
  passesFr3: boolean;
}>;

export type LadderExact = Readonly<{
  step: 'Legacy' | 'TriangleFree';
  status: string;
  published: SpikeView | null;
  mesh: SpikeMesh | null;
}>;

export type LadderExport = Readonly<{
  batchStatus: number;
  pathStatus: number | null;
  positions: readonly HexPoint[] | null;
  triangles: readonly Triangle[] | null;
  boundaryEdges: readonly Pair[] | null;
}>;

export type LadderEntry = Readonly<{
  name: string;
  kind: 'path' | 'view';
  rule: FillRule;
  exponent: number;
  faults: readonly string[];
  rung: 'fast' | 'fallback';
  reason: LadderReason | null;
  meshCheckItem: number;
  allocations: number;
  maxDeviationSquared: string | null;
  fastMesh: SpikeMesh | null;
  boundaryEdges: readonly Pair[] | null;
  view: SpikeView | null;
  prefixFailure: string | null;
  spike: LadderSpike;
  exact: LadderExact | null;
  /** Paths only: the ladder's own exact result equals the exact rung run alone. */
  ladderExactAgrees: boolean | null;
  export: LadderExport | null;
}>;

export type LadderDump = Readonly<{
  schema: typeof DUMP_SCHEMA;
  /** `fill_v0_revision()` of the dumping kernel. */
  revision: number;
  entries: readonly LadderEntry[];
}>;

function fail(message: string): never {
  throw new Error(`ladder dump: ${message}`);
}

function record(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${where} is not an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort()))
    fail(`${where} keys mismatch: ${actual.join(',')}`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, where: string, signed = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!signed && value < 0))
    fail(`${where} is not an integer`);
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(`${where} is not a boolean`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} is not a string`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} is not an array`);
  return value;
}

function nullable<T>(value: unknown, parse: (item: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(`${where} is invalid`);
  return value as T;
}

function hex(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/u.test(value)) fail(`${where} is not hex`);
  const exponent = Number((BigInt(`0x${value}`) >> 52n) & 0x7ffn);
  if (exponent === 0x7ff) fail(`${where} is not finite`);
  return value;
}

function hexPoint(value: unknown, where: string): HexPoint {
  const pair = list(value, where);
  if (pair.length !== 2) fail(`${where} is not a point`);
  return [hex(pair[0], `${where}.x`), hex(pair[1], `${where}.y`)];
}

function tuple<N extends 2 | 3>(value: unknown, size: N, where: string): number[] {
  const items = list(value, where);
  if (items.length !== size) fail(`${where} has ${items.length} items`);
  return items.map((item, index) => integer(item, `${where}[${index}]`));
}

function owner(value: unknown, where: string): SpikeOwner {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'line' || kind === 'explicitClose') {
    const item = record(value, ['kind', 'sourceVerb'], where);
    return { kind, sourceVerb: integer(item.sourceVerb, where) };
  }
  if (kind === 'cubicLeaf') {
    const item = record(value, ['kind', 'sourceVerb', 'endNumerator', 'depth'], where);
    return {
      kind,
      sourceVerb: integer(item.sourceVerb, where),
      endNumerator: integer(item.endNumerator, where),
      depth: integer(item.depth, where),
    };
  }
  if (kind === 'implicitClosure') {
    const item = record(value, ['kind', 'contour'], where);
    return { kind, contour: integer(item.contour, where) };
  }
  return fail(`${where} has an unknown owner kind`);
}

function source(value: unknown, where: string): SpikeSource {
  const item = record(value, ['kind', 'sourceVerb', 'contour', 'points'], where);
  const kind = oneOf(item.kind, ['line', 'cubic'] as const, `${where}.kind`);
  const points = list(item.points, where).map((point, index) =>
    hexPoint(point, `${where}.points[${index}]`),
  );
  if (points.length !== (kind === 'line' ? 2 : 4)) fail(`${where} has the wrong point count`);
  return {
    kind,
    sourceVerb: integer(item.sourceVerb, where),
    contour: integer(item.contour, where),
    points,
  };
}

function view(value: unknown, where: string): SpikeView {
  const item = record(value, ['ranges', 'points', 'owners', 'sources'], where);
  return {
    ranges: list(item.ranges, `${where}.ranges`).map(
      (range, index) => tuple(range, 2, `${where}.ranges[${index}]`) as unknown as Pair,
    ),
    points: list(item.points, `${where}.points`).map((point, index) =>
      hexPoint(point, `${where}.points[${index}]`),
    ),
    owners: list(item.owners, `${where}.owners`).map((entry, index) =>
      owner(entry, `${where}.owners[${index}]`),
    ),
    sources: list(item.sources, `${where}.sources`).map((entry, index) =>
      source(entry, `${where}.sources[${index}]`),
    ),
  };
}

function triangles(value: unknown, where: string): Triangle[] {
  return list(value, where).map(
    (triangle, index) => tuple(triangle, 3, `${where}[${index}]`) as unknown as Triangle,
  );
}

function pairs(value: unknown, where: string): Pair[] {
  return list(value, where).map(
    (pair, index) => tuple(pair, 2, `${where}[${index}]`) as unknown as Pair,
  );
}

function mesh(value: unknown, where: string): SpikeMesh {
  const item = record(value, ['vertices', 'triangles'], where);
  return {
    vertices: list(item.vertices, `${where}.vertices`).map((point, index) =>
      hexPoint(point, `${where}.vertices[${index}]`),
    ),
    triangles: triangles(item.triangles, `${where}.triangles`),
  };
}

const ENTRY_KEYS = [
  'name',
  'kind',
  'rule',
  'exponent',
  'faults',
  'rung',
  'reason',
  'meshCheckItem',
  'allocations',
  'maxDeviationSquared',
  'fastMesh',
  'boundaryEdges',
  'view',
  'prefixFailure',
  'spike',
  'exact',
  'export',
];

function entry(value: unknown, where: string): LadderEntry {
  const kind = (value as { kind?: unknown } | null)?.kind;
  const item = record(
    value,
    kind === 'path' ? [...ENTRY_KEYS, 'ladderExactAgrees'] : ENTRY_KEYS,
    where,
  );
  const rung = oneOf(item.rung, ['fast', 'fallback'] as const, `${where}.rung`);
  const reason = nullable(item.reason, (reason) =>
    oneOf(reason, LADDER_REASONS, `${where}.reason`),
  );
  const fastMesh = nullable(item.fastMesh, (value) => mesh(value, `${where}.fastMesh`));
  const boundaryEdges = nullable(item.boundaryEdges, (value) =>
    pairs(value, `${where}.boundaryEdges`),
  );
  if ((rung === 'fallback') !== (reason !== null)) fail(`${where} rung/reason mismatch`);
  if ((rung === 'fast') !== (fastMesh !== null) || (fastMesh === null) !== (boundaryEdges === null))
    fail(`${where} rung/mesh mismatch`);
  const spike = record(item.spike, ['rung', 'reason', 'sameMesh', 'passesFr3'], `${where}.spike`);
  const exact = nullable(item.exact, (value) => {
    const exactItem = record(value, ['step', 'status', 'published', 'mesh'], `${where}.exact`);
    return {
      step: oneOf(exactItem.step, ['Legacy', 'TriangleFree'] as const, `${where}.exact.step`),
      status: text(exactItem.status, `${where}.exact.status`),
      published: nullable(exactItem.published, (published) =>
        view(published, `${where}.exact.published`),
      ),
      mesh: nullable(exactItem.mesh, (exactMesh) => mesh(exactMesh, `${where}.exact.mesh`)),
    };
  });
  const exported = nullable(item.export, (value) => {
    const exportItem = record(
      value,
      ['batchStatus', 'pathStatus', 'positions', 'triangles', 'boundaryEdges'],
      `${where}.export`,
    );
    return {
      batchStatus: integer(exportItem.batchStatus, `${where}.export.batchStatus`),
      pathStatus: nullable(exportItem.pathStatus, (status) =>
        integer(status, `${where}.export.pathStatus`),
      ),
      positions: nullable(exportItem.positions, (positions) =>
        list(positions, `${where}.export.positions`).map((point, index) =>
          hexPoint(point, `${where}.export.positions[${index}]`),
        ),
      ),
      triangles: nullable(exportItem.triangles, (value) =>
        triangles(value, `${where}.export.triangles`),
      ),
      boundaryEdges: nullable(exportItem.boundaryEdges, (value) =>
        pairs(value, `${where}.export.boundaryEdges`),
      ),
    };
  });
  if ((kind === 'path') !== (exact !== null && exported !== null))
    fail(`${where} exact and export belong to paths only`);
  return {
    name: text(item.name, `${where}.name`),
    kind: oneOf(kind, ['path', 'view'] as const, `${where}.kind`),
    rule: oneOf(item.rule, ['nonzero', 'evenodd'] as const, `${where}.rule`),
    exponent: integer(item.exponent, `${where}.exponent`, true),
    faults: list(item.faults, `${where}.faults`).map((fault, index) =>
      text(fault, `${where}.faults[${index}]`),
    ),
    rung,
    reason,
    meshCheckItem: integer(item.meshCheckItem, `${where}.meshCheckItem`),
    allocations: integer(item.allocations, `${where}.allocations`),
    maxDeviationSquared: nullable(item.maxDeviationSquared, (value) =>
      hex(value, `${where}.maxDeviationSquared`),
    ),
    fastMesh,
    boundaryEdges,
    view: nullable(item.view, (value) => view(value, `${where}.view`)),
    prefixFailure: nullable(item.prefixFailure, (value) => text(value, `${where}.prefixFailure`)),
    spike: {
      rung: oneOf(spike.rung, ['fast', 'fallback'] as const, `${where}.spike.rung`),
      reason: nullable(spike.reason, (value) => text(value, `${where}.spike.reason`)),
      sameMesh: bool(spike.sameMesh, `${where}.spike.sameMesh`),
      passesFr3: bool(spike.passesFr3, `${where}.spike.passesFr3`),
    },
    exact,
    ladderExactAgrees:
      kind === 'path' ? bool(item.ladderExactAgrees, `${where}.ladderExactAgrees`) : null,
    export: exported,
  };
}

/**
 * Extracts and strictly parses the one framed dump: a header line with the schema, the kernel
 * revision and the entry count, then one JSON entry per line.
 */
export function parseLadderDump(output: string): LadderDump {
  if (output.split(DUMP_BEGIN).length !== 2 || output.split(DUMP_END).length !== 2)
    fail('expected exactly one frame');
  const body = output.slice(
    output.indexOf(DUMP_BEGIN) + DUMP_BEGIN.length,
    output.indexOf(DUMP_END),
  );
  const lines = body.split(/\r?\n/u).filter((line) => line !== '');
  if (lines.length === 0) fail('frame has no header');
  const header = record(JSON.parse(lines[0]!), ['schema', 'revision', 'entries'], 'header');
  if (header.schema !== DUMP_SCHEMA) fail('schema mismatch');
  const entries = lines.slice(1).map((line, index) => entry(JSON.parse(line), `entries[${index}]`));
  if (entries.length !== integer(header.entries, 'header.entries'))
    fail(`header announces ${String(header.entries)} entries, frame has ${entries.length}`);
  return {
    schema: DUMP_SCHEMA,
    revision: integer(header.revision, 'header.revision'),
    entries,
  };
}
