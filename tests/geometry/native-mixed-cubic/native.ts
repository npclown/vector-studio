import {
  integer,
  parseNativeCubicCarrier,
  parseNativeCubicOwner,
  record,
  type NativeCubicCarrier,
  type NativeCubicEdgeOwner,
} from '../native-cubic/native.js';
import {
  parseNativeTransverseCubicTopology,
  type NativeTransverseCubicTopology,
} from '../native-transverse-cubic/native.js';

export type NativeMixedCubicEdgeOwner =
  NativeCubicEdgeOwner | Readonly<{ kind: 'Line'; source_verb: number }>;

export type NativeMixedCubicRow = Readonly<{
  carrier: NativeCubicCarrier<NativeMixedCubicEdgeOwner>;
  topology: NativeTransverseCubicTopology;
  source_kinds: readonly boolean[];
}>;

function owner(value: unknown, label: string): NativeMixedCubicEdgeOwner {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === 'Line'
  ) {
    const item = record(value, label, ['kind', 'source_verb']);
    const sourceVerb = integer(item.source_verb, `${label}.source_verb`);
    if (sourceVerb > 0xffff_ffff) throw new Error(`${label}.source_verb exceeds u32`);
    return { kind: 'Line', source_verb: sourceVerb };
  }
  return parseNativeCubicOwner(value, label);
}

export function parseNativeMixedCubicValueWithStats(
  value: unknown,
  index: number,
  expectedStats: Readonly<{ leaves: number; pairs: number }>,
): NativeMixedCubicRow {
  const label = `row ${index}`;
  const item = record(value, label, ['carrier', 'topology', 'source_kinds']);
  const carrier = parseNativeCubicCarrier(item.carrier, index, owner);
  if (!Array.isArray(item.source_kinds)) throw new Error(`${label}.source_kinds must be an array`);
  const sourceKinds = Array.from(item.source_kinds);
  if (
    sourceKinds.length < 1 ||
    sourceKinds.length > 16 ||
    sourceKinds.some((kind) => typeof kind !== 'boolean')
  )
    throw new Error(`${label}.source_kinds shape invalid`);
  const sourceCount = carrier.source_bits.reduce((sum, contour) => sum + contour.length, 0);
  if (sourceKinds.length !== sourceCount)
    throw new Error(`${label}.source_kinds/source_bits count mismatch`);
  return {
    carrier,
    topology: parseNativeTransverseCubicTopology(item.topology, index, expectedStats),
    source_kinds: sourceKinds as readonly boolean[],
  };
}

export function parseNativeMixedCubicValue(value: unknown, index: number): NativeMixedCubicRow {
  return parseNativeMixedCubicValueWithStats(value, index, { leaves: 8, pairs: 28 });
}

export function parseNativeMixedCubicRow(line: string, index: number): NativeMixedCubicRow {
  return parseNativeMixedCubicValue(JSON.parse(line) as unknown, index);
}
