import type { Point } from '../../../packages/geometry-reference/src/types.js';
import { parseNativeRoundedValue, type NativeRoundedRow } from '../rounded-fill/native.js';
import type { NativeCubicRule } from './fixtures.js';

export type NativeCubicPlan = Readonly<{
  status: number;
  verb_count: number;
  point_count: number;
}>;

export type NativeCubicStatistics = Readonly<{
  logical_cubics: number;
  sizing_visits: number;
  emission_visits: number;
  emitted_cubic_lines: number;
}>;

export type NativeCubicProvenance = Readonly<{
  source_verb: number;
  end_numerator: number;
  depth: number;
}>;

export type NativeCubicCommand = Readonly<{
  verb: 0 | 1 | 3;
  point: Point | null;
  provenance: NativeCubicProvenance;
}>;

export type NativeCubicEdgeOwner =
  | Readonly<{
      kind: 'CubicLeaf';
      source_verb: number;
      end_numerator: number;
      depth: number;
    }>
  | Readonly<{ kind: 'ImplicitClosure'; contour: number }>;

export type NativeCubicCarrier<Owner> = Readonly<{
  id: string;
  rule: NativeCubicRule;
  source_bits: readonly (readonly (readonly string[])[])[];
  flatten_tolerance_bits: string;
  topology_tolerance_bits: string;
  flat_status: number;
  sizing_plan: NativeCubicPlan;
  emission_plan: NativeCubicPlan | null;
  statistics: NativeCubicStatistics;
  flat_bounds: readonly [number, number, number, number] | null;
  commands: readonly NativeCubicCommand[] | null;
  edge_owners: readonly Owner[] | null;
  rounded: NativeRoundedRow | null;
  allocations: number;
  allocated_bytes: number;
  inline_bytes: number;
}>;

export type NativeCubicRow = NativeCubicCarrier<NativeCubicEdgeOwner>;

export function record(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} keys mismatch`);
  return result;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

export function integer(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  )
    throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${label} must be finite`);
  return value;
}

function point(value: unknown, label: string): Point {
  const tuple = array(value, label);
  if (tuple.length !== 2) throw new Error(`${label} must contain two coordinates`);
  return [finite(tuple[0], `${label}[0]`), finite(tuple[1], `${label}[1]`)];
}

function bits(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[0-9a-f]{16}$/u.test(result)) throw new Error(`${label} must be lowercase Float64 bits`);
  const raw = BigInt(`0x${result}`);
  if ((raw & 0x7ff0000000000000n) === 0x7ff0000000000000n)
    throw new Error(`${label} must encode a finite Float64`);
  return result;
}

function plan(value: unknown, label: string): NativeCubicPlan {
  const item = record(value, label, ['status', 'verb_count', 'point_count']);
  return {
    status: integer(item.status, `${label}.status`),
    verb_count: integer(item.verb_count, `${label}.verb_count`),
    point_count: integer(item.point_count, `${label}.point_count`),
  };
}

function provenance(value: unknown, label: string): NativeCubicProvenance {
  const item = record(value, label, ['source_verb', 'end_numerator', 'depth']);
  return {
    source_verb: integer(item.source_verb, `${label}.source_verb`),
    end_numerator: integer(item.end_numerator, `${label}.end_numerator`),
    depth: integer(item.depth, `${label}.depth`),
  };
}

function command(value: unknown, label: string): NativeCubicCommand {
  const item = record(value, label, ['verb', 'point', 'provenance']);
  const verb = integer(item.verb, `${label}.verb`);
  if (verb !== 0 && verb !== 1 && verb !== 3) throw new Error(`${label}.verb invalid`);
  if ((verb === 3) !== (item.point === null)) throw new Error(`${label}.point/verb mismatch`);
  return {
    verb,
    point: item.point === null ? null : point(item.point, `${label}.point`),
    provenance: provenance(item.provenance, `${label}.provenance`),
  };
}

export function parseNativeCubicOwner(value: unknown, label: string): NativeCubicEdgeOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'CubicLeaf') {
    const item = record(value, label, ['kind', 'source_verb', 'end_numerator', 'depth']);
    return {
      kind,
      source_verb: integer(item.source_verb, `${label}.source_verb`),
      end_numerator: integer(item.end_numerator, `${label}.end_numerator`),
      depth: integer(item.depth, `${label}.depth`),
    };
  }
  if (kind === 'ImplicitClosure') {
    const item = record(value, label, ['kind', 'contour']);
    return { kind, contour: integer(item.contour, `${label}.contour`) };
  }
  throw new Error(`${label}.kind invalid`);
}

export function parseNativeCubicRow(line: string, index: number): NativeCubicRow {
  return parseNativeCubicValue(JSON.parse(line) as unknown, index);
}

export function parseNativeCubicValue(value: unknown, index: number): NativeCubicRow {
  return parseNativeCubicCarrier(value, index, parseNativeCubicOwner);
}

export function parseNativeCubicCarrier<Owner>(
  value: unknown,
  index: number,
  parseOwner: (value: unknown, label: string) => Owner,
): NativeCubicCarrier<Owner> {
  const label = `row ${index}`;
  const item = record(value, label, [
    'id',
    'rule',
    'source_bits',
    'flatten_tolerance_bits',
    'topology_tolerance_bits',
    'flat_status',
    'sizing_plan',
    'emission_plan',
    'statistics',
    'flat_bounds',
    'commands',
    'edge_owners',
    'rounded',
    'allocations',
    'allocated_bytes',
    'inline_bytes',
  ]);
  const id = string(item.id, `${label}.id`);
  const rule = string(item.rule, `${label}.rule`);
  if (rule !== 'nonzero' && rule !== 'evenodd') throw new Error(`${label}.rule invalid`);
  const source_bits = array(item.source_bits, `${label}.source_bits`).map((contour, contourIndex) =>
    array(contour, `${label}.source_bits[${contourIndex}]`).map((cubic, cubicIndex) => {
      const components = array(cubic, `${label}.source_bits[${contourIndex}][${cubicIndex}]`);
      if (components.length !== 8)
        throw new Error(`${label}.source_bits[${contourIndex}][${cubicIndex}] length`);
      return components.map((component, componentIndex) =>
        bits(component, `${label}.source_bits[${contourIndex}][${cubicIndex}][${componentIndex}]`),
      );
    }),
  );
  if (
    source_bits.length < 1 ||
    source_bits.length > 4 ||
    source_bits.some((contour) => contour.length < 1)
  )
    throw new Error(`${label}.source_bits contour shape invalid`);
  if (source_bits.reduce((sum, contour) => sum + contour.length, 0) > 16)
    throw new Error(`${label}.source_bits has too many cubics`);
  const flat_status = integer(item.flat_status, `${label}.flat_status`);
  if (flat_status !== 0 && flat_status !== 4) throw new Error(`${label}.flat_status invalid`);
  const sizing_plan = plan(item.sizing_plan, `${label}.sizing_plan`);
  const emission_plan =
    item.emission_plan === null ? null : plan(item.emission_plan, `${label}.emission_plan`);
  const statisticsRecord = record(item.statistics, `${label}.statistics`, [
    'logical_cubics',
    'sizing_visits',
    'emission_visits',
    'emitted_cubic_lines',
  ]);
  const statistics = {
    logical_cubics: integer(statisticsRecord.logical_cubics, `${label}.statistics.logical_cubics`),
    sizing_visits: integer(statisticsRecord.sizing_visits, `${label}.statistics.sizing_visits`),
    emission_visits: integer(
      statisticsRecord.emission_visits,
      `${label}.statistics.emission_visits`,
    ),
    emitted_cubic_lines: integer(
      statisticsRecord.emitted_cubic_lines,
      `${label}.statistics.emitted_cubic_lines`,
    ),
  };
  let flat_bounds: readonly [number, number, number, number] | null = null;
  if (item.flat_bounds !== null) {
    const values = array(item.flat_bounds, `${label}.flat_bounds`);
    if (values.length !== 4) throw new Error(`${label}.flat_bounds length`);
    flat_bounds = values.map((entry, component) =>
      finite(entry, `${label}.flat_bounds[${component}]`),
    ) as [number, number, number, number];
  }
  const commands =
    item.commands === null
      ? null
      : array(item.commands, `${label}.commands`).map((entry, commandIndex) =>
          command(entry, `${label}.commands[${commandIndex}]`),
        );
  if (commands !== null && commands.length > 72) throw new Error(`${label}.commands exceeds limit`);
  const edge_owners =
    item.edge_owners === null
      ? null
      : array(item.edge_owners, `${label}.edge_owners`).map((entry, ownerIndex) =>
          parseOwner(entry, `${label}.edge_owners[${ownerIndex}]`),
        );
  if (edge_owners !== null && edge_owners.length > 64)
    throw new Error(`${label}.edge_owners exceeds limit`);
  const rounded = item.rounded === null ? null : parseNativeRoundedValue(item.rounded, index);
  if (rounded !== null && (rounded.id !== id || rounded.rule !== rule))
    throw new Error(`${label}.rounded identity mismatch`);

  if (sizing_plan.status !== flat_status) throw new Error(`${label}.sizing status mismatch`);
  if (flat_status === 4) {
    if (
      emission_plan !== null ||
      flat_bounds !== null ||
      commands !== null ||
      edge_owners !== null ||
      rounded !== null
    )
      throw new Error(`${label} sizing failure published output`);
  } else if (
    emission_plan === null ||
    emission_plan.status !== 0 ||
    flat_bounds === null ||
    commands === null ||
    edge_owners === null ||
    rounded === null
  ) {
    throw new Error(`${label} successful row is incomplete`);
  }

  return {
    id,
    rule,
    source_bits,
    flatten_tolerance_bits: bits(item.flatten_tolerance_bits, `${label}.flatten_tolerance_bits`),
    topology_tolerance_bits: bits(item.topology_tolerance_bits, `${label}.topology_tolerance_bits`),
    flat_status,
    sizing_plan,
    emission_plan,
    statistics,
    flat_bounds,
    commands,
    edge_owners,
    rounded,
    allocations: integer(item.allocations, `${label}.allocations`),
    allocated_bytes: integer(item.allocated_bytes, `${label}.allocated_bytes`),
    inline_bytes: integer(item.inline_bytes, `${label}.inline_bytes`),
  };
}
