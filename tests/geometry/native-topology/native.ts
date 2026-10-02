import type { Point } from '../../../packages/geometry-reference/src/types.js';

export type NativeTopologyStatus =
  | 'Certified'
  | 'InvalidLimits'
  | 'AllocationFailed'
  | 'ByteLimit'
  | 'InvalidInput'
  | 'InvalidProvenance'
  | 'KnotMismatch'
  | 'Unresolved'
  | 'WorkLimit';

export type NativeTopologyRange = Readonly<{ start: number; count: number }>;

export type NativeTopologyOutput = Readonly<{
  points: readonly Point[];
  contours: readonly NativeTopologyRange[];
  orientations: readonly (-1 | 1)[];
  winding: readonly (readonly (-1 | 0 | 1)[])[];
}>;

export type NativeTopologyRow = Readonly<{
  id: string;
  input_tokens: readonly string[];
  status: NativeTopologyStatus;
  leaves: number;
  pairs: number;
  output: NativeTopologyOutput | null;
  allocations: number;
  allocated_bytes: number;
  inline_bytes: number;
}>;

const STATUSES = [
  'Certified',
  'InvalidLimits',
  'AllocationFailed',
  'ByteLimit',
  'InvalidInput',
  'InvalidProvenance',
  'KnotMismatch',
  'Unresolved',
  'WorkLimit',
] as const satisfies readonly NativeTopologyStatus[];
const ID = /^[A-Za-z0-9/-]+$/u;

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

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function integer(value: unknown, label: string): number {
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

function range(value: unknown, label: string): NativeTopologyRange {
  const item = record(value, label, ['start', 'count']);
  return {
    start: integer(item.start, `${label}.start`),
    count: integer(item.count, `${label}.count`),
  };
}

function orientation(value: unknown, label: string): -1 | 1 {
  if (value !== -1 && value !== 1) throw new Error(`${label} must be -1 or 1`);
  return value;
}

function winding(value: unknown, label: string): -1 | 0 | 1 {
  if (value !== -1 && value !== 0 && value !== 1) throw new Error(`${label} must be -1, 0 or 1`);
  return value;
}

function output(value: unknown, label: string): NativeTopologyOutput {
  const item = record(value, label, ['points', 'contours', 'orientations', 'winding']);
  const points = array(item.points, `${label}.points`).map((entry, index) =>
    point(entry, `${label}.points[${index}]`),
  );
  const contours = array(item.contours, `${label}.contours`).map((entry, index) =>
    range(entry, `${label}.contours[${index}]`),
  );
  const orientations = array(item.orientations, `${label}.orientations`).map((entry, index) =>
    orientation(entry, `${label}.orientations[${index}]`),
  );
  const windingRows = array(item.winding, `${label}.winding`).map((entry, rowIndex) => {
    const row = array(entry, `${label}.winding[${rowIndex}]`);
    if (row.length !== 4) throw new Error(`${label}.winding[${rowIndex}] length`);
    return row.map((cell, columnIndex) =>
      winding(cell, `${label}.winding[${rowIndex}][${columnIndex}]`),
    );
  });
  if (
    contours.length < 1 ||
    contours.length > 4 ||
    orientations.length !== contours.length ||
    windingRows.length !== contours.length ||
    points.length > 64
  )
    throw new Error(`${label} shape mismatch`);
  let end = 0;
  for (const contour of contours) {
    if (contour.start !== end || contour.count < 3)
      throw new Error(`${label} contour partition invalid`);
    end += contour.count;
  }
  if (end !== points.length) throw new Error(`${label} contour partition incomplete`);
  for (let rowIndex = 0; rowIndex < windingRows.length; rowIndex += 1) {
    if (windingRows[rowIndex]![rowIndex] !== 0)
      throw new Error(`${label}.winding diagonal must be zero`);
    if (windingRows[rowIndex]!.slice(contours.length).some((cell) => cell !== 0))
      throw new Error(`${label}.winding unused columns must be zero`);
  }
  return { points, contours, orientations, winding: windingRows };
}

export function parseNativeTopologyRow(line: string, index: number): NativeTopologyRow {
  return parseNativeTopologyValue(JSON.parse(line) as unknown, index);
}

export function parseNativeTopologyValue(value: unknown, index: number): NativeTopologyRow {
  const label = `row ${index}`;
  const item = record(value, label, [
    'id',
    'input_tokens',
    'status',
    'leaves',
    'pairs',
    'output',
    'allocations',
    'allocated_bytes',
    'inline_bytes',
  ]);
  const status = string(item.status, `${label}.status`);
  if (!STATUSES.includes(status as NativeTopologyStatus))
    throw new Error(`${label}.status invalid`);
  const parsedOutput = item.output === null ? null : output(item.output, `${label}.output`);
  if ((status === 'Certified') !== (parsedOutput !== null))
    throw new Error(`${label} output/status mismatch`);
  const inputTokens = array(item.input_tokens, `${label}.input_tokens`).map((entry, tokenIndex) =>
    string(entry, `${label}.input_tokens[${tokenIndex}]`),
  );
  if (inputTokens.some((token) => token.length === 0 || /\s/u.test(token)))
    throw new Error(`${label}.input_tokens contains a noncanonical token`);
  const leaves = integer(item.leaves, `${label}.leaves`);
  const pairs = integer(item.pairs, `${label}.pairs`);
  if (leaves > 64 || pairs > 2016) throw new Error(`${label} counters exceed fixed limits`);
  const id = string(item.id, `${label}.id`);
  if (!ID.test(id)) throw new Error(`${label}.id invalid`);
  return {
    id,
    input_tokens: inputTokens,
    status: status as NativeTopologyStatus,
    leaves,
    pairs,
    output: parsedOutput,
    allocations: integer(item.allocations, `${label}.allocations`),
    allocated_bytes: integer(item.allocated_bytes, `${label}.allocated_bytes`),
    inline_bytes: integer(item.inline_bytes, `${label}.inline_bytes`),
  };
}
