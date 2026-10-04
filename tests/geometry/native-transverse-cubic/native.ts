import { parseNativeCubicValue, type NativeCubicRow } from '../native-cubic/native.js';

export type NativeTransverseCubicTopologyError =
  | 'InvalidLimits'
  | 'AllocationFailed'
  | 'ByteLimit'
  | 'InvalidInput'
  | 'InvalidProvenance'
  | 'KnotMismatch'
  | 'Unresolved'
  | 'WorkLimit';

export type NativeTransverseCubicTopology = Readonly<{
  topology_invoked: boolean;
  rounded_topology_invoked: boolean;
  rounded_topology_selected: boolean;
  rounded_topology_error: NativeTransverseCubicTopologyError | null;
  transverse_topology_invoked: boolean;
  transverse_topology_selected: boolean;
  transverse_topology_error: NativeTransverseCubicTopologyError | null;
  stats: Readonly<{ leaves: number; pairs: number }>;
}>;

export type NativeTransverseCubicRow = Readonly<{
  carrier: NativeCubicRow;
  topology: NativeTransverseCubicTopology;
}>;

const TOPOLOGY_ERRORS = new Set<NativeTransverseCubicTopologyError>([
  'InvalidLimits',
  'AllocationFailed',
  'ByteLimit',
  'InvalidInput',
  'InvalidProvenance',
  'KnotMismatch',
  'Unresolved',
  'WorkLimit',
]);

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort()))
    throw new Error(`${label} keys mismatch`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function error(value: unknown, label: string): NativeTransverseCubicTopologyError | null {
  if (
    value !== null &&
    (typeof value !== 'string' || !TOPOLOGY_ERRORS.has(value as NativeTransverseCubicTopologyError))
  )
    throw new Error(`${label} invalid`);
  return value as NativeTransverseCubicTopologyError | null;
}

function counter(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new Error(`${label} outside fixed limits`);
  return value as number;
}

export function parseNativeTransverseCubicValueWithStats(
  value: unknown,
  index: number,
  expectedStats: Readonly<{ leaves: number; pairs: number }>,
): NativeTransverseCubicRow {
  const label = `row ${index}`;
  const item = record(value, label, ['carrier', 'topology']);
  const topology = record(item.topology, `${label}.topology`, [
    'topology_invoked',
    'rounded_topology_invoked',
    'rounded_topology_selected',
    'rounded_topology_error',
    'transverse_topology_invoked',
    'transverse_topology_selected',
    'transverse_topology_error',
    'stats',
  ]);
  const parsed = {
    topology_invoked: boolean(topology.topology_invoked, `${label}.topology.topology_invoked`),
    rounded_topology_invoked: boolean(
      topology.rounded_topology_invoked,
      `${label}.topology.rounded_topology_invoked`,
    ),
    rounded_topology_selected: boolean(
      topology.rounded_topology_selected,
      `${label}.topology.rounded_topology_selected`,
    ),
    rounded_topology_error: error(
      topology.rounded_topology_error,
      `${label}.topology.rounded_topology_error`,
    ),
    transverse_topology_invoked: boolean(
      topology.transverse_topology_invoked,
      `${label}.topology.transverse_topology_invoked`,
    ),
    transverse_topology_selected: boolean(
      topology.transverse_topology_selected,
      `${label}.topology.transverse_topology_selected`,
    ),
    transverse_topology_error: error(
      topology.transverse_topology_error,
      `${label}.topology.transverse_topology_error`,
    ),
  };
  if (
    !parsed.topology_invoked ||
    parsed.rounded_topology_invoked ||
    parsed.rounded_topology_selected ||
    parsed.rounded_topology_error !== null ||
    !parsed.transverse_topology_invoked ||
    !parsed.transverse_topology_selected ||
    parsed.transverse_topology_error !== null
  )
    throw new Error(`${label}.topology route contradiction`);
  const stats = record(topology.stats, `${label}.topology.stats`, ['leaves', 'pairs']);
  const leaves = counter(stats.leaves, `${label}.topology.stats.leaves`, 64);
  const pairs = counter(stats.pairs, `${label}.topology.stats.pairs`, 2016);
  if (leaves !== expectedStats.leaves || pairs !== expectedStats.pairs)
    throw new Error(`${label}.topology stats mismatch`);
  return {
    carrier: parseNativeCubicValue(item.carrier, index),
    topology: { ...parsed, stats: { leaves, pairs } },
  };
}

export function parseNativeTransverseCubicValue(
  value: unknown,
  index: number,
): NativeTransverseCubicRow {
  return parseNativeTransverseCubicValueWithStats(value, index, { leaves: 8, pairs: 28 });
}

export function parseNativeTransverseCubicRow(
  line: string,
  index: number,
): NativeTransverseCubicRow {
  return parseNativeTransverseCubicValue(JSON.parse(line) as unknown, index);
}
