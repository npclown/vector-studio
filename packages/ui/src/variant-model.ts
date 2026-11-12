import type {
  Command,
  DocumentV8,
  Effect,
  InstanceNodeV8,
  NodeOverride,
  NodeV8,
  Paint,
  Stroke,
  SymbolNodeV8,
  SymbolSetNode,
} from '@vector-studio/react';
import {
  colorHex,
  isGradient,
  numberText,
  parseHex,
  parseNumber,
  styleKeys,
} from './appearance-model.js';
import { layerInSource, sourceOf } from './instance-focus.js';
import type { PropertyAction } from './property-model.js';

// V-37 contract, sections 6.1 and 6.2 (U4): the pure side of the variant and instance panels.
// Every control turns one committed value into one public command (section 4); the editor
// validates every value, and a refusal shows its code as the other property sections do.

const nodeAt = (document: DocumentV8, id: string): NodeV8 | undefined =>
  Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;

const symbolsOf = (document: DocumentV8, set: SymbolSetNode): readonly SymbolNodeV8[] =>
  set.children.flatMap((id) => {
    const node = nodeAt(document, id);
    return node?.type === 'symbol' ? [node] : [];
  });

// ---------------------------------------------------------------------------------------------
// 6.1 Selection of symbols and sets

/** "Combine as variants" for two or more selected symbols, none of them in a set. */
export function combineAction(
  document: DocumentV8,
  selection: readonly string[],
): PropertyAction | null {
  if (selection.length < 2) return null;
  const free = selection.every((id) => {
    const node = nodeAt(document, id);
    return node?.type === 'symbol' && nodeAt(document, node.parent)?.type !== 'symbolSet';
  });
  if (!free) return null;
  return {
    label: 'Combine as variants',
    command: { type: 'combineAsVariants', ids: [...selection] },
    selectResult: true,
  };
}

/** One property of a set: its name and its values in first-appearance order. */
export type SetProperty = Readonly<{ name: string; values: readonly string[] }>;

/** A set's properties (V37-S2): each name of its variants, with its values in order. */
export function setProperties(document: DocumentV8, set: SymbolSetNode): readonly SetProperty[] {
  const variants = symbolsOf(document, set);
  const names = Object.keys(variants[0]?.variant ?? {});
  return names.map((name) => ({
    name,
    values: [
      ...new Set(
        variants.flatMap((variant) => {
          const value = variant.variant?.[name];
          return value === undefined ? [] : [value];
        }),
      ),
    ],
  }));
}

/** The one selected set, or null. */
export function selectedSet(
  document: DocumentV8,
  selection: readonly string[],
): SymbolSetNode | null {
  if (selection.length !== 1) return null;
  const node = nodeAt(document, selection[0]!);
  return node?.type === 'symbolSet' ? node : null;
}

/** The rename of property `from` to `to` across the set; null for blank, same or taken names. */
export function renamePropertyCommand(
  document: DocumentV8,
  set: SymbolSetNode,
  from: string,
  to: string,
): Command | null {
  const names = setProperties(document, set).map((property) => property.name);
  if (to === '' || to === from || !names.includes(from) || names.includes(to)) return null;
  return {
    type: 'setVariantProperties',
    updates: symbolsOf(document, set).map((variant) => ({
      id: variant.id,
      variant: Object.fromEntries(
        Object.entries(variant.variant ?? {}).map(([name, value]) => [
          name === from ? to : name,
          value,
        ]),
      ),
    })),
  };
}

/** The removal of property `name` from every variant; null with one property left. */
export function removePropertyCommand(
  document: DocumentV8,
  set: SymbolSetNode,
  name: string,
): Command | null {
  const names = setProperties(document, set).map((property) => property.name);
  if (names.length < 2 || !names.includes(name)) return null;
  return {
    type: 'setVariantProperties',
    updates: symbolsOf(document, set).map((variant) => ({
      id: variant.id,
      variant: Object.fromEntries(
        Object.entries(variant.variant ?? {}).filter(([entry]) => entry !== name),
      ),
    })),
  };
}

/**
 * "Add property": a new property `Property N` (the smallest N above the property count that is
 * free) with the value `Default` on every variant. Equal values on every variant keep the
 * variants distinct, so V37-N2's suffixes never apply here.
 */
export function addPropertyCommand(document: DocumentV8, set: SymbolSetNode): Command {
  const names = new Set(setProperties(document, set).map((property) => property.name));
  let n = names.size + 1;
  while (names.has(`Property ${n}`)) n += 1;
  return {
    type: 'setVariantProperties',
    updates: symbolsOf(document, set).map((variant) => ({
      id: variant.id,
      variant: { ...variant.variant, [`Property ${n}`]: 'Default' },
    })),
  };
}

/**
 * "Add variant": `duplicateNodes` of the selected variant (a symbol of the set) or, when none
 * is selected, the set's first variant; the copy is then selected.
 */
export function addVariantAction(
  document: DocumentV8,
  set: SymbolSetNode,
  selected: string | null = null,
): PropertyAction | null {
  const target = selected !== null && set.children.includes(selected) ? selected : set.children[0];
  if (target === undefined || symbolsOf(document, set).length === 0) return null;
  return {
    label: 'Add variant',
    command: { type: 'duplicateNodes', ids: [target] },
    selectResult: true,
  };
}

/** One value field of a selected variant. */
export type VariantField = Readonly<{ name: string; value: string }>;

/** The variant fields of a selected symbol in a set, one per property, else null. */
export function variantFields(
  document: DocumentV8,
  selection: readonly string[],
): Readonly<{ id: string; fields: readonly VariantField[] }> | null {
  if (selection.length !== 1) return null;
  const node = nodeAt(document, selection[0]!);
  if (node?.type !== 'symbol' || node.variant === undefined) return null;
  if (nodeAt(document, node.parent)?.type !== 'symbolSet') return null;
  return {
    id: node.id,
    fields: Object.entries(node.variant).map(([name, value]) => ({ name, value })),
  };
}

/** A value field's commit: the symbol's whole `variant` with `name` set (one `setVariantProperties`). */
export function variantValueCommand(
  document: DocumentV8,
  id: string,
  name: string,
  value: string,
): Command | null {
  const node = nodeAt(document, id);
  if (node?.type !== 'symbol' || node.variant === undefined) return null;
  return {
    type: 'setVariantProperties',
    updates: [{ id, variant: { ...node.variant, [name]: value } }],
  };
}

// ---------------------------------------------------------------------------------------------
// 6.2 Instances: variant dropdowns

/** One value of a dropdown; `disabled` when no variant has it with the other current values. */
export type VariantOption = Readonly<{ value: string; disabled: boolean }>;

/** One property dropdown of an instance. */
export type VariantDropdown = Readonly<{
  name: string;
  /** The current variant's value. */
  value: string;
  options: readonly VariantOption[];
}>;

/** The set of the source of instance `id`, or null when the source is in no set. */
function setOfInstance(document: DocumentV8, id: string): SymbolSetNode | null {
  const source = sourceOf(document, id);
  const symbol = source === null ? undefined : nodeAt(document, source);
  const set = symbol === undefined ? undefined : nodeAt(document, symbol.parent);
  return set?.type === 'symbolSet' ? set : null;
}

/**
 * The Variant section of an instance whose source is in a set: one dropdown per property listing
 * the set's values; a value no variant has together with the other current values is disabled.
 * Null for an instance of a source outside a set.
 */
export function variantDropdowns(
  document: DocumentV8,
  id: string,
): readonly VariantDropdown[] | null {
  const set = setOfInstance(document, id);
  const instance = nodeAt(document, id);
  if (set === null || instance?.type !== 'instance') return null;
  const current = (nodeAt(document, instance.symbol) as SymbolNodeV8).variant ?? {};
  const variants = symbolsOf(document, set);
  return setProperties(document, set).map((property) => ({
    name: property.name,
    value: current[property.name] ?? '',
    options: property.values.map((value) => ({
      value,
      disabled: !variants.some((variant) =>
        Object.entries({ ...current, [property.name]: value }).every(
          ([name, wanted]) => variant.variant?.[name] === wanted,
        ),
      ),
    })),
  }));
}

/** Picking `value` of property `name`: `setInstanceVariant`. */
export const instanceVariantCommand = (id: string, name: string, value: string): Command => ({
  type: 'setInstanceVariant',
  id,
  values: { [name]: value },
});

// ---------------------------------------------------------------------------------------------
// 6.2 Instances: layers and focused layer controls

/** One row of the Layers list: a node of the source subtree. */
export type InstanceLayerRow = Readonly<{
  id: string;
  name: string;
  type: NodeV8['type'];
  /** 0 for the source, one more per container above the row. */
  depth: number;
  /** The instance holds a property or text override for this node. */
  overridden: boolean;
}>;

/** The source subtree of instance `id` in pre-order, the source first; empty for no source. */
export function instanceLayers(document: DocumentV8, id: string): readonly InstanceLayerRow[] {
  const source = sourceOf(document, id);
  const instance = nodeAt(document, id) as InstanceNodeV8 | undefined;
  if (source === null || instance === undefined) return [];
  const rows: InstanceLayerRow[] = [];
  const visit = (node: NodeV8 | undefined, depth: number) => {
    if (node === undefined) return;
    rows.push({
      id: node.id,
      name: node.name,
      type: node.type,
      depth,
      overridden:
        Object.hasOwn(instance.overrides ?? {}, node.id) ||
        Object.hasOwn(instance.textOverrides, node.id),
    });
    if ('children' in node)
      for (const child of node.children) visit(nodeAt(document, child), depth + 1);
  };
  visit(nodeAt(document, source), 0);
  return rows;
}

/** What the focused layer's controls show and which of them apply to it. */
export type LayerControls = Readonly<{
  /** The source node with the instance's override applied (text runs stay the node's own). */
  node: NodeV8;
  isSource: boolean;
  fill: boolean;
  stroke: boolean;
  /** Opacity, the visibility toggle and the Effects list do not apply to the source itself. */
  inner: boolean;
}>;

/** The controls of `layer` of instance `id`, or null when the layer is not in its source. */
export function layerControls(
  document: DocumentV8,
  id: string,
  layer: string,
): LayerControls | null {
  const instance = nodeAt(document, id);
  const node = nodeAt(document, layer);
  if (instance?.type !== 'instance' || node === undefined) return null;
  if (!layerInSource(document, id, layer)) return null;
  const override: NodeOverride = instance.overrides?.[layer] ?? {};
  const keys = styleKeys(node.type);
  return {
    node: { ...node, ...override } as NodeV8,
    isSource: layer === instance.symbol,
    fill: keys.includes('fill'),
    stroke: keys.includes('stroke'),
    inner: layer !== instance.symbol,
  };
}

/** `setInstanceOverride` of one or more fields of `layer`. */
export const overrideCommand = (id: string, layer: string, props: NodeOverride): Command => ({
  type: 'setInstanceOverride',
  id,
  node: layer,
  props,
});

/** The fill field's text: `#rrggbb` for a solid fill, '' for none, null for a gradient. */
export function fillText(paint: Paint | null): string | null {
  if (paint === null) return '';
  return isGradient(paint) ? null : colorHex(paint);
}

/** The alpha of a solid paint, 1 for none or a gradient. */
const alphaOf = (paint: Paint | null): number =>
  paint === null || isGradient(paint) ? 1 : (paint as { a: number }).a;

/** A fill field's commit: a hex keeps the shown alpha, an empty text removes the fill. */
export function fillOverrideCommand(
  id: string,
  layer: string,
  shown: Paint | null,
  text: string,
): Command | null {
  if (text.trim() === '') return overrideCommand(id, layer, { fill: null });
  const color = parseHex(text, alphaOf(shown));
  return color === null ? null : overrideCommand(id, layer, { fill: color });
}

/** The stroke a colour edit starts from when the layer has none. */
const DEFAULT_STROKE: Stroke = {
  color: { r: 0, g: 0, b: 0, a: 1 },
  width: 1,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  dash: null,
};

/** A stroke colour field's commit: the shown stroke with its colour changed; empty removes it. */
export function strokeOverrideCommand(
  id: string,
  layer: string,
  shown: Stroke | null,
  text: string,
): Command | null {
  if (text.trim() === '') return overrideCommand(id, layer, { stroke: null });
  const color = parseHex(text, alphaOf(shown?.color ?? null));
  return color === null
    ? null
    : overrideCommand(id, layer, { stroke: { ...(shown ?? DEFAULT_STROKE), color } });
}

/** The opacity in percent as the field shows it. */
export const opacityPercent = (opacity: number): string =>
  numberText(Math.round(opacity * 1000) / 10);

/** An opacity field's commit (0 to 100 %); null when the text is not one. */
export function opacityOverrideCommand(id: string, layer: string, text: string): Command | null {
  const percent = parseNumber(text.replace(/%\s*$/u, ''), 0, 100);
  return percent === null ? null : overrideCommand(id, layer, { opacity: percent / 100 });
}

/** The visibility toggle. */
export const visibleOverrideCommand = (id: string, layer: string, visible: boolean): Command =>
  overrideCommand(id, layer, { visible: !visible });

/** E41's defaults (`addEffect`), applied to an override's effect list here. */
const DEFAULT_SHADOW: Effect = {
  kind: 'dropShadow',
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 0,
  offsetY: 4,
  radius: 8,
};
const DEFAULT_BLUR: Effect = { kind: 'layerBlur', visible: true, radius: 4 };
const PATCH_KEYS: Readonly<Record<Effect['kind'], readonly string[]>> = {
  dropShadow: ['visible', 'color', 'offsetX', 'offsetY', 'radius'],
  layerBlur: ['visible', 'radius'],
};

/**
 * The override a node-level effect command (`addEffect`, `setEffect`, `removeEffect`, as the
 * E41 effects model builds them) becomes for a layer of an instance: the command applied to the
 * layer's shown effect list, written as `setInstanceOverride`. Null for any other command.
 */
export function effectOverrideCommand(
  id: string,
  layer: string,
  effects: readonly Effect[],
  command: Command,
): Command | null {
  let next: readonly Effect[];
  if (command.type === 'addEffect') {
    next = [...effects, command.kind === 'dropShadow' ? DEFAULT_SHADOW : DEFAULT_BLUR];
  } else if (command.type === 'setEffect') {
    next = effects.map((effect, index) => {
      if (index !== command.index) return effect;
      const keys = PATCH_KEYS[effect.kind].filter((key) => Object.hasOwn(command.patch, key));
      return {
        ...effect,
        ...Object.fromEntries(
          keys.map((key) => [key, (command.patch as Record<string, unknown>)[key]]),
        ),
      };
    });
  } else if (command.type === 'removeEffect') {
    next = effects.filter((_, index) => index !== command.index);
  } else {
    return null;
  }
  return overrideCommand(id, layer, { effects: next });
}

/** "Reset" of the focused layer: `resetInstanceOverrides` of its node. */
export const resetLayerAction = (id: string, layer: string): PropertyAction => ({
  label: 'Reset',
  command: { type: 'resetInstanceOverrides', id, node: layer },
  selectResult: false,
});

/** "Reset all overrides", next to "Detach instance". */
export const resetAllAction = (id: string): PropertyAction => ({
  label: 'Reset all overrides',
  command: { type: 'resetInstanceOverrides', id },
  selectResult: false,
});
