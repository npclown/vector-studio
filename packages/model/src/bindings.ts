import type {
  BindingKey,
  BindingRef,
  Color,
  ColorStyle,
  DocumentV8,
  NodeV8,
  Paint,
  TextRun,
  Variable,
  VariableSet,
} from './types.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), sections 2 and 3: the pure
// rules of bindings, shared by the model's document check (V39-S5, S6) and the editor's resync
// (E1), bind (E2) and detach (E4) passes.

/** The binding keys in canonical order (V39-S4, V39-S7). */
export const BINDING_KEYS: readonly BindingKey[] = Object.freeze([
  'fill',
  'stroke',
  'text',
  'opacity',
  'strokeWidth',
  'cornerRadius',
]);

/** The most colour styles, and the most variables (V39-S1, S2). */
export const MAX_COLOR_STYLES = 1000;
export const MAX_VARIABLES = 1000;
/** The most modes of the variable set (V39-S2). */
export const MAX_VARIABLE_MODES = 16;
/** The longest style, variable or mode name in UTF-16 units (V39-S3). */
export const MAX_TABLE_NAME_LENGTH = 200;

const FILL_TYPES = new Set([
  'rectangle',
  'ellipse',
  'path',
  'custom',
  'frame',
  'symbol',
  'symbolSet',
]);
const STROKE_TYPES = new Set([
  'rectangle',
  'ellipse',
  'line',
  'path',
  'custom',
  'frame',
  'symbol',
  'symbolSet',
]);

/**
 * Whether nodes of `type` have the field `key` binds (V39-S4 read by type, V39-S6's node rule):
 * not whether the field is currently non-null.
 */
export function bindingKeyAllowed(type: string, key: BindingKey): boolean {
  switch (key) {
    case 'fill':
      return FILL_TYPES.has(type);
    case 'stroke':
    case 'strokeWidth':
      return STROKE_TYPES.has(type);
    case 'text':
      return type === 'text';
    case 'opacity':
      return true;
    case 'cornerRadius':
      return type === 'rectangle';
  }
}

/** Whether `key` binds a paint (a style or a colour variable) rather than a number. */
export function isPaintKey(key: BindingKey): boolean {
  return key === 'fill' || key === 'stroke' || key === 'text';
}

/** The tables a binding resolves against: a document's, or a draft's. */
export type BindingTables = Readonly<{
  colorStyles?: readonly ColorStyle[];
  variables?: VariableSet;
}>;

/** What a reference names, or null when it names nothing. */
export type BindingTarget =
  | Readonly<{ kind: 'style'; style: ColorStyle }>
  | Readonly<{ kind: 'variable'; variable: Variable }>;

export function bindingTarget(tables: BindingTables, ref: BindingRef): BindingTarget | null {
  if ('style' in ref) {
    const style = tables.colorStyles?.find((entry) => entry.id === ref.style);
    return style === undefined ? null : { kind: 'style', style };
  }
  const variable = tables.variables?.items.find((entry) => entry.id === ref.variable);
  return variable === undefined ? null : { kind: 'variable', variable };
}

/** Whether `paint` is a solid colour. */
export function isColor(paint: Paint): paint is Color {
  return !('stops' in paint);
}

/** The inclusive range of a number key (V39-S5); paint keys have none. */
export function bindingRange(key: BindingKey): readonly [number, number] {
  return key === 'opacity' ? [0, 1] : [0, Infinity];
}

/**
 * Whether `target` may bind `key` at all (V39-S4's reference column, E3's `binding-type`): a
 * style or colour variable on a paint key, a style with a solid paint on `text`, a number
 * variable on a number key.
 */
export function bindingTypeFits(target: BindingTarget, key: BindingKey): boolean {
  if (target.kind === 'style') {
    if (!isPaintKey(key)) return false;
    return key !== 'text' || isColor(target.style.paint);
  }
  return isPaintKey(key) ? target.variable.type === 'color' : target.variable.type === 'number';
}

/**
 * Whether every mode's value of a number variable is in `key`'s range (V39-S5: the range holds
 * in every mode, so switching modes never leaves it).
 */
export function bindingRangeFits(target: BindingTarget, key: BindingKey): boolean {
  if (target.kind !== 'variable' || target.variable.type !== 'number') return true;
  const [min, max] = bindingRange(key);
  return Object.values(target.variable.values).every((value) => value >= min && value <= max);
}

/** The resolved value of a target in the active mode `mode`, or undefined when it has none. */
export function resolvedValue(
  target: BindingTarget,
  mode: string | undefined,
): Paint | number | undefined {
  if (target.kind === 'style') return target.style.paint;
  if (mode === undefined || !Object.hasOwn(target.variable.values, mode)) return undefined;
  return target.variable.values[mode];
}

/** Deep equality of two paints (V39-S5): per channel, gradients by kind, transform, stops, spread. */
export function samePaint(a: Paint, b: Paint): boolean {
  if (isColor(a) || isColor(b)) {
    return isColor(a) && isColor(b) && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  }
  return (
    a.kind === b.kind &&
    a.spread === b.spread &&
    a.transform.every((value, index) => value === b.transform[index]) &&
    a.stops.length === b.stops.length &&
    a.stops.every(
      (stop, index) =>
        stop.offset === b.stops[index]!.offset && samePaint(stop.color, b.stops[index]!.color),
    )
  );
}

/**
 * The current value of a node's bound property, or null when the field is absent or null (or,
 * for `text`, the runs disagree; for `cornerRadius`, the radii differ).
 */
export function boundValue(node: NodeV8, key: BindingKey): Paint | number | null {
  const record = node as Partial<Record<string, unknown>>;
  switch (key) {
    case 'fill': {
      // V-35: a `fill` binding holds the top fill's paint (fills are bottom first).
      const fills = record.fills as readonly { paint: Paint }[] | undefined;
      return fills?.at(-1)?.paint ?? null;
    }
    case 'stroke': {
      const stroke = record.stroke as { color: Paint } | null | undefined;
      return stroke?.color ?? null;
    }
    case 'strokeWidth': {
      const stroke = record.stroke as { width: number } | null | undefined;
      return stroke?.width ?? null;
    }
    case 'opacity':
      return node.opacity;
    case 'cornerRadius': {
      const radii = record.cornerRadii as readonly number[] | undefined;
      if (radii === undefined || radii.some((radius) => radius !== radii[0])) return null;
      return radii[0]!;
    }
    case 'text': {
      if (node.type !== 'text') return null;
      const first = node.runs[0]!.color;
      return node.runs.every((run) => samePaint(run.color, first)) ? first : null;
    }
  }
}

/** Whether a node's binding of `key` to `ref` holds against `tables` (V39-S5, E4). */
export function bindingHolds(
  node: NodeV8,
  key: BindingKey,
  ref: BindingRef,
  tables: BindingTables,
): boolean {
  if (!bindingKeyAllowed(node.type, key)) return false;
  const target = bindingTarget(tables, ref);
  if (target === null || !bindingTypeFits(target, key) || !bindingRangeFits(target, key)) {
    return false;
  }
  const expected = resolvedValue(target, tables.variables?.mode);
  const actual = boundValue(node, key);
  if (expected === undefined || actual === null) return false;
  if (typeof expected === 'number' || typeof actual === 'number') return expected === actual;
  return samePaint(expected, actual);
}

function sameRunStyle(a: TextRun, b: TextRun): boolean {
  return a.family === b.family && a.size === b.size && samePaint(a.color, b.color);
}

/** Runs with `color` everywhere, adjacent runs of one style merged (M6a-S1). */
export function recolourRuns(runs: readonly TextRun[], color: Color): TextRun[] {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const next = { ...run, color: { r: color.r, g: color.g, b: color.b, a: color.a } };
    const last = merged[merged.length - 1];
    if (last !== undefined && sameRunStyle(last, next)) {
      merged[merged.length - 1] = { ...last, text: last.text + next.text };
    } else {
      merged.push(next);
    }
  }
  return merged;
}

/**
 * The node with its `key` property set to `value` (E1, E2), or null when the node cannot take it
 * (no such field, a null field other than `fill` and `stroke`, a gradient on `text`). A null
 * `stroke` is created from `defaultStroke`.
 */
export function withBoundValue(
  node: NodeV8,
  key: BindingKey,
  value: Paint | number,
  defaultStroke: (node: NodeV8) => Readonly<Record<string, unknown>>,
): NodeV8 | null {
  if (!bindingKeyAllowed(node.type, key)) return null;
  const record = node as unknown as Record<string, unknown>;
  const stroke = record.stroke as Record<string, unknown> | null | undefined;
  switch (key) {
    case 'fill': {
      // V-35: the top fill's paint, or one fill of the paint when the node has none.
      if (typeof value === 'number') return null;
      const fills = (record.fills as readonly Record<string, unknown>[] | undefined) ?? [];
      const top = fills.at(-1);
      const next =
        top === undefined
          ? [{ paint: value, visible: true, opacity: 1, blendMode: 'normal' }]
          : [...fills.slice(0, -1), { ...top, paint: value }];
      return { ...node, fills: next } as unknown as NodeV8;
    }
    case 'stroke':
      if (typeof value === 'number') return null;
      return { ...node, stroke: { ...(stroke ?? defaultStroke(node)), color: value } } as NodeV8;
    case 'strokeWidth':
      if (typeof value !== 'number' || stroke == null) return null;
      return { ...node, stroke: { ...stroke, width: value } } as NodeV8;
    case 'opacity':
      return typeof value === 'number' ? { ...node, opacity: value } : null;
    case 'cornerRadius':
      return typeof value === 'number'
        ? ({ ...node, cornerRadii: [value, value, value, value] } as NodeV8)
        : null;
    case 'text':
      if (node.type !== 'text' || typeof value === 'number' || !isColor(value)) return null;
      return { ...node, runs: recolourRuns(node.runs, value) };
  }
}

/** The table IDs of a document: styles, variables and modes (V39-S3). */
export function tableIds(document: BindingTables): string[] {
  return [
    ...(document.colorStyles ?? []).map((style) => style.id),
    ...(document.variables?.items ?? []).map((variable) => variable.id),
    ...(document.variables?.modes ?? []).map((mode) => mode.id),
  ];
}

/** The tables of a document, as a draft carries them over (V39-E4). */
export function tablesOf(document: DocumentV8): BindingTables {
  return {
    ...(document.colorStyles === undefined ? {} : { colorStyles: document.colorStyles }),
    ...(document.variables === undefined ? {} : { variables: document.variables }),
  };
}
