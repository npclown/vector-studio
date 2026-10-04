import type { Point } from '../../../packages/geometry-reference/src/types.js';
import {
  array,
  integer,
  orientation,
  parseNativeTopologyEnvelope,
  point,
  range,
  record,
  type NativeTopologyEnvelope,
  type NativeTopologyRange,
} from '../native-topology/native.js';

export type NativeTransverseArrangementCrossing = Readonly<{
  left_leaf: number;
  right_leaf: number;
  orientation: -1 | 1;
}>;

export type NativeTransverseArrangementOutput = Readonly<{
  points: readonly Point[];
  contours: readonly NativeTopologyRange[];
  crossings: readonly NativeTransverseArrangementCrossing[];
}>;

export type NativeTransverseArrangementRow =
  NativeTopologyEnvelope<NativeTransverseArrangementOutput>;

function output(value: unknown, label: string): NativeTransverseArrangementOutput {
  const item = record(value, label, ['points', 'contours', 'crossings']);
  const points = array(item.points, `${label}.points`).map((entry, index) =>
    point(entry, `${label}.points[${index}]`),
  );
  const contours = array(item.contours, `${label}.contours`).map((entry, index) =>
    range(entry, `${label}.contours[${index}]`),
  );
  const crossings = array(item.crossings, `${label}.crossings`).map((entry, index) => {
    const crossingLabel = `${label}.crossings[${index}]`;
    const crossing = record(entry, crossingLabel, ['left_leaf', 'right_leaf', 'orientation']);
    return {
      left_leaf: integer(crossing.left_leaf, `${crossingLabel}.left_leaf`),
      right_leaf: integer(crossing.right_leaf, `${crossingLabel}.right_leaf`),
      orientation: orientation(crossing.orientation, `${crossingLabel}.orientation`),
    };
  });
  if (contours.length < 1 || contours.length > 4 || points.length > 64 || crossings.length > 32)
    throw new Error(`${label} shape mismatch`);
  let end = 0;
  for (const contour of contours) {
    if (contour.start !== end || contour.count < 3)
      throw new Error(`${label} contour partition invalid`);
    end += contour.count;
  }
  if (end !== points.length) throw new Error(`${label} contour partition incomplete`);
  let previousLeft = -1;
  let previousRight = -1;
  const partners = new Set<number>();
  for (const crossing of crossings) {
    if (crossing.left_leaf >= crossing.right_leaf || crossing.right_leaf >= points.length)
      throw new Error(`${label} crossing index invalid`);
    if (
      crossing.left_leaf < previousLeft ||
      (crossing.left_leaf === previousLeft && crossing.right_leaf <= previousRight)
    )
      throw new Error(`${label} crossing order invalid`);
    if (partners.has(crossing.left_leaf) || partners.has(crossing.right_leaf))
      throw new Error(`${label} crossing partner repeated`);
    partners.add(crossing.left_leaf);
    partners.add(crossing.right_leaf);
    previousLeft = crossing.left_leaf;
    previousRight = crossing.right_leaf;
  }
  return { points, contours, crossings };
}

export function parseNativeTransverseArrangementRow(
  line: string,
  index: number,
): NativeTransverseArrangementRow {
  return parseNativeTransverseArrangementValue(JSON.parse(line) as unknown, index);
}

export function parseNativeTransverseArrangementValue(
  value: unknown,
  index: number,
): NativeTransverseArrangementRow {
  const row = parseNativeTopologyEnvelope(value, index, output);
  if (
    row.output !== null &&
    (row.leaves !== row.output.points.length || row.pairs !== (row.leaves * (row.leaves - 1)) / 2)
  )
    throw new Error(`row ${index} certified counters mismatch`);
  return row;
}
