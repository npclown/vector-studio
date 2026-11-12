import type {
  BindingKey,
  BindingRef,
  Color,
  ColorStyle,
  Command,
  DocumentV8,
  NodeV8,
  Paint,
  Variable,
  VariableSet,
} from '@vector-studio/react';
import { colorHex, isGradient, numberText } from './appearance-model.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), section 5, U2 to U4: the pure
// side of the style menus, the number bind buttons and the Local styles panel. The panels read
// the document's tables and the selected nodes' bindings, and turn one action into one command
// (`bindProperty` and the table commands); the editor checks every value (E3).

/** The tables a panel reads: a document's colour styles and variables. */
export type StyleTables = Readonly<{
  colorStyles?: readonly ColorStyle[];
  variables?: VariableSet;
}>;

/** What a binding names, for display: its name, and a swatch or a number value. */
export type BindingLabel = Readonly<{
  name: string;
  /** A CSS background for a paint target, or null for a number. */
  swatch: string | null;
  /** The resolved value as text: `#rrggbb`, `Gradient`, or a number. */
  value: string;
}>;

/** A row's binding across the nodes it writes: none, one shared reference, or mixed. */
export type BindingState =
  | Readonly<{ state: 'none' }>
  | Readonly<{ state: 'one'; ref: BindingRef; label: BindingLabel }>
  | Readonly<{ state: 'mixed' }>;

/** A choice in a style menu or a bind menu. */
export type BindOption = Readonly<{
  ref: BindingRef;
  /** `style` or `variable`, for the menu's groups. */
  kind: 'style' | 'variable';
  label: BindingLabel;
}>;

/** The paint of a new style from the Local styles panel's `+` (U4): `#D9D9D9`. */
export const NEW_STYLE_PAINT: Color = Object.freeze({
  r: 217 / 255,
  g: 217 / 255,
  b: 217 / 255,
  a: 1,
});

/** Whether the binding key binds a paint (a style or a colour variable). */
export const isPaintBinding = (key: BindingKey): boolean =>
  key === 'fill' || key === 'stroke' || key === 'text';

/** The inclusive range of a number key (V39-S5). */
export function bindingRangeOf(key: BindingKey): readonly [number, number] {
  return key === 'opacity' ? [0, 1] : [0, Infinity];
}

const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

/** A paint as a CSS background: a colour with its alpha, a gradient as a left-to-right ramp. */
export function paintCss(paint: Paint): string {
  if (!isGradient(paint)) {
    return `rgba(${channel(paint.r)}, ${channel(paint.g)}, ${channel(paint.b)}, ${paint.a})`;
  }
  const stops = paint.stops.map(
    (stop) => `${paintCss(stop.color)} ${Math.round(stop.offset * 1000) / 10}%`,
  );
  return `${paint.kind === 'radial' ? 'radial-gradient(circle' : 'linear-gradient(90deg'}, ${stops.join(', ')})`;
}

const paintText = (paint: Paint) => (isGradient(paint) ? 'Gradient' : colorHex(paint));

/** The active mode's value of a variable, or undefined. */
function activeValue(tables: StyleTables, variable: Variable): Color | number | undefined {
  const mode = tables.variables?.mode;
  if (mode === undefined || !Object.hasOwn(variable.values, mode)) return undefined;
  return variable.values[mode];
}

function styleLabel(style: ColorStyle): BindingLabel {
  return { name: style.name, swatch: paintCss(style.paint), value: paintText(style.paint) };
}

function variableLabel(tables: StyleTables, variable: Variable): BindingLabel {
  const value = activeValue(tables, variable);
  if (value === undefined) return { name: variable.name, swatch: null, value: '' };
  if (typeof value === 'number') {
    return { name: variable.name, swatch: null, value: numberText(value) };
  }
  return { name: variable.name, swatch: paintCss(value), value: colorHex(value) };
}

/** The label of what `ref` names, or null when it names nothing. */
export function bindingLabel(tables: StyleTables, ref: BindingRef): BindingLabel | null {
  if ('style' in ref) {
    const style = tables.colorStyles?.find((entry) => entry.id === ref.style);
    return style === undefined ? null : styleLabel(style);
  }
  const variable = tables.variables?.items.find((entry) => entry.id === ref.variable);
  return variable === undefined ? null : variableLabel(tables, variable);
}

const sameRef = (a: BindingRef, b: BindingRef) =>
  'style' in a ? 'style' in b && a.style === b.style : 'variable' in b && a.variable === b.variable;

/**
 * The binding of `key` across `nodes` (the nodes the row writes): none when no node is bound,
 * one when every node is bound to the same reference, else mixed (U2: `Mixed`).
 */
export function bindingState(
  tables: StyleTables,
  nodes: readonly NodeV8[],
  key: BindingKey,
): BindingState {
  const refs = nodes.map((node) => node.bindings?.[key] ?? null);
  if (refs.every((ref) => ref === null)) return { state: 'none' };
  const first = refs[0] ?? null;
  if (first === null || refs.some((ref) => ref === null || !sameRef(ref, first))) {
    return { state: 'mixed' };
  }
  const label = bindingLabel(tables, first);
  return label === null ? { state: 'mixed' } : { state: 'one', ref: first, label };
}

/**
 * The style menu's choices for a paint key (U2): the colour styles (only solid ones for `text`,
 * V39-E3's `binding-type`), then the colour variables.
 */
export function paintOptions(tables: StyleTables, key: BindingKey): BindOption[] {
  const styles = (tables.colorStyles ?? [])
    .filter((style) => key !== 'text' || !isGradient(style.paint))
    .map((style) => ({
      ref: { style: style.id },
      kind: 'style' as const,
      label: styleLabel(style),
    }));
  const variables = (tables.variables?.items ?? [])
    .filter((variable) => variable.type === 'color')
    .map((variable) => ({
      ref: { variable: variable.id },
      kind: 'variable' as const,
      label: variableLabel(tables, variable),
    }));
  return [...styles, ...variables];
}

/**
 * The bind menu's choices for a number key (U3): the number variables whose value in every mode
 * is in the key's range (V39-S5), so a choice never fails on `binding-range`.
 */
export function numberOptions(tables: StyleTables, key: BindingKey): BindOption[] {
  const [min, max] = bindingRangeOf(key);
  return (tables.variables?.items ?? [])
    .filter(
      (variable) =>
        variable.type === 'number' &&
        Object.values(variable.values).every((value) => value >= min && value <= max),
    )
    .map((variable) => ({
      ref: { variable: variable.id },
      kind: 'variable' as const,
      label: variableLabel(tables, variable),
    }));
}

/** `bindProperty` of `key` on `ids` to `ref`, or detaching it with null (V39-E2). */
export function bindCommand(
  ids: readonly string[],
  key: BindingKey,
  ref: BindingRef | null,
): Command {
  return { type: 'bindProperty', ids: [...ids], key, ref };
}

/** `Color <n>`: the first n from the table's size up that no style has as its name (U2, U4). */
export function nextStyleName(tables: StyleTables): string {
  const names = new Set((tables.colorStyles ?? []).map((style) => style.name));
  let n = names.size + 1;
  while (names.has(`Color ${n}`)) n += 1;
  return `Color ${n}`;
}

/** `Mode <n>`, as `nextStyleName`, for a new mode (U4). */
export function nextModeName(tables: StyleTables): string {
  const names = new Set((tables.variables?.modes ?? []).map((mode) => mode.name));
  let n = names.size + 1;
  while (names.has(`Mode ${n}`)) n += 1;
  return `Mode ${n}`;
}

/** A new variable's name (U4): `Color <n>` or `Number <n>`, as `nextStyleName`. */
export function nextVariableName(tables: StyleTables, kind: Variable['type']): string {
  const prefix = kind === 'color' ? 'Color' : 'Number';
  const names = new Set((tables.variables?.items ?? []).map((variable) => variable.name));
  let n = (tables.variables?.items ?? []).filter((variable) => variable.type === kind).length + 1;
  while (names.has(`${prefix} ${n}`)) n += 1;
  return `${prefix} ${n}`;
}

/** The style a row's Create style makes: the first paint of the row (U2). */
export function createStyleCommand(tables: StyleTables, paint: Paint): Command {
  return { type: 'createColorStyle', name: nextStyleName(tables), paint };
}

/** The tables of a document, for the panels. */
export function tablesOfDocument(document: DocumentV8): StyleTables {
  return {
    ...(document.colorStyles === undefined ? {} : { colorStyles: document.colorStyles }),
    ...(document.variables === undefined ? {} : { variables: document.variables }),
  };
}
