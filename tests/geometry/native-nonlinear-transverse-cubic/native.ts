import {
  parseNativeTransverseCubicValueWithStats,
  type NativeTransverseCubicRow,
} from '../native-transverse-cubic/native.js';

export type NativeNonlinearTransverseCubicRow = NativeTransverseCubicRow;

function expectedStats(index: number): Readonly<{ leaves: number; pairs: number }> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 8)
    throw new Error('nonlinear transverse cubic row index outside fixed inventory');
  return index >= 6 ? { leaves: 9, pairs: 36 } : { leaves: 8, pairs: 28 };
}

export function parseNativeNonlinearTransverseCubicValue(
  value: unknown,
  index: number,
): NativeNonlinearTransverseCubicRow {
  return parseNativeTransverseCubicValueWithStats(value, index, expectedStats(index));
}

export function parseNativeNonlinearTransverseCubicRow(
  line: string,
  index: number,
): NativeNonlinearTransverseCubicRow {
  return parseNativeNonlinearTransverseCubicValue(JSON.parse(line) as unknown, index);
}
