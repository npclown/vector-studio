import type {
  Color,
  Command,
  CommandResult,
  DocumentV8,
  Effect,
  NodeV8,
} from '@vector-studio/react';
import { numberText, parseHex, parseNumber, type Common } from './appearance-model.js';

// E41-U7 (E41 contract, section 6): the property panel's "Effects" section. Each row is one
// effect index; with several nodes selected a row covers every selected node that has an effect
// at that index ("holders"), and a field shows "mixed" where they differ. Add appends to each
// selected node (`addEffect`); a field edit patches the row's index on each holder
// (`setEffect`, which applies a key only to holders whose kind takes it); remove removes it
// (`removeEffect`). One committed value is one command and one undo step. V-36 (contract
// section 6) adds inner shadow and background blur, offered only when the host projects them
// (the `effectKinds` query), and a kind select per row within the row's family.

export type EffectKind = Effect['kind'] | 'mixed';

/** A kind's family: the kinds a row's kind select switches between. */
export const effectFamily = (kind: Effect['kind']): 'shadow' | 'blur' =>
  kind === 'dropShadow' || kind === 'innerShadow' ? 'shadow' : 'blur';

const ids = (nodes: readonly NodeV8[]) => nodes.map((node) => node.id);

const isShadow = (effect: Effect) => effect.kind === 'dropShadow' || effect.kind === 'innerShadow';

/** One effect index over the selected nodes. */
export type EffectRow = Readonly<{
  index: number;
  /** The kind the holders share, or 'mixed'. */
  kind: EffectKind;
  /** Whether any holder is a shadow (the colour and offset fields then show). */
  shadow: boolean;
  /** The family the holders share, or 'mixed' (the kind select is then disabled). */
  family: 'shadow' | 'blur' | 'mixed';
  visible: Common<boolean>;
  color: Common<Color>;
  offsetX: Common<number>;
  offsetY: Common<number>;
  radius: Common<number>;
}>;

/** The common value of `read` over `values`, compared as JSON (as the property model's). */
function commonOf<N, T>(values: readonly N[], read: (value: N) => T): Common<T> {
  let found: { value: T; text: string } | null = null;
  for (const value of values) {
    const next = read(value);
    const text = JSON.stringify(next);
    if (found === null) found = { value: next, text };
    else if (found.text !== text) return { state: 'mixed' };
  }
  return found === null ? { state: 'none' } : { state: 'one', value: found.value };
}

/** The S3 field ranges the panel accepts; the model checks every value again. */
export const EFFECT_RADIUS_RANGE = Object.freeze([0, 1000] as const);
export const EFFECT_OFFSET_RANGE = Object.freeze([-10_000, 10_000] as const);

/** The rows for the selected nodes, one per index up to the longest list. */
export function effectRows(nodes: readonly NodeV8[]): readonly EffectRow[] {
  const length = Math.max(0, ...nodes.map((node) => node.effects.length));
  const rows: EffectRow[] = [];
  for (let index = 0; index < length; index += 1) {
    const effects = nodes.flatMap((node) =>
      index < node.effects.length ? [node.effects[index]!] : [],
    );
    const shadows = effects.flatMap((effect) =>
      effect.kind === 'dropShadow' || effect.kind === 'innerShadow' ? [effect] : [],
    );
    const kind = commonOf(effects, (effect) => effect.kind);
    const family = commonOf(effects, (effect) => effectFamily(effect.kind));
    rows.push({
      index,
      kind: kind.state === 'one' ? kind.value : 'mixed',
      shadow: effects.some(isShadow),
      family: family.state === 'one' ? family.value : 'mixed',
      visible: commonOf(effects, (effect) => effect.visible),
      color: commonOf(shadows, (effect) => effect.color),
      offsetX: commonOf(shadows, (effect) => effect.offsetX),
      offsetY: commonOf(shadows, (effect) => effect.offsetY),
      radius: commonOf(effects, (effect) => effect.radius),
    });
  }
  return rows;
}

const LABELS: Readonly<Record<EffectKind, string>> = {
  dropShadow: 'Drop shadow',
  innerShadow: 'Inner shadow',
  layerBlur: 'Layer blur',
  backgroundBlur: 'Background blur',
  mixed: 'Mixed',
};

/** A row's label as the panel shows it. */
export const effectLabel = (kind: EffectKind): string => LABELS[kind];

/**
 * The kinds a row's kind select offers: the offered kinds of the row's family, or none when the
 * holders differ in family. A row whose kind the host no longer offers keeps it listed.
 */
export function kindOptions(
  row: EffectRow,
  offered: readonly Effect['kind'][],
): readonly Effect['kind'][] {
  if (row.family === 'mixed') return [];
  const options = offered.filter((kind) => effectFamily(kind) === row.family);
  return row.kind !== 'mixed' && !options.includes(row.kind) ? [...options, row.kind] : options;
}

/** The kind select's commit: a `kind` patch at the row's index (within the family). */
export const effectKindCommand = (
  nodes: readonly NodeV8[],
  row: EffectRow,
  kind: Effect['kind'],
): Command => ({ type: 'setEffect', ids: ids(nodes), index: row.index, patch: { kind } });

/**
 * Whether a selected node is a mask group's source (its first child): its effects stay in the
 * document but do not render (E41 contract, section 3), so the panel shows them disabled.
 */
export function isMaskSource(document: DocumentV8, node: NodeV8): boolean {
  const owner = Object.hasOwn(document.nodes, node.parent)
    ? document.nodes[node.parent]
    : undefined;
  return owner?.type === 'maskGroup' && owner.children[0] === node.id;
}

export const addEffectCommand = (nodes: readonly NodeV8[], kind: Effect['kind']): Command => ({
  type: 'addEffect',
  ids: ids(nodes),
  kind,
});

export const removeEffectCommand = (nodes: readonly NodeV8[], index: number): Command => ({
  type: 'removeEffect',
  ids: ids(nodes),
  index,
});

/** The visible toggle: shows every holder when any is hidden (or they differ), else hides. */
export function toggleEffectCommand(nodes: readonly NodeV8[], row: EffectRow): Command {
  const visible = !(row.visible.state === 'one' && row.visible.value);
  return { type: 'setEffect', ids: ids(nodes), index: row.index, patch: { visible } };
}

export type EffectNumberKey = 'offsetX' | 'offsetY' | 'radius';

/** A number field's commit, or null when the text cannot be a value in S3's range. */
export function effectNumberCommand(
  nodes: readonly NodeV8[],
  row: EffectRow,
  key: EffectNumberKey,
  text: string,
): Command | null {
  const [min, max] = key === 'radius' ? EFFECT_RADIUS_RANGE : EFFECT_OFFSET_RANGE;
  const value = parseNumber(text, min, max);
  if (value === null) return null;
  return { type: 'setEffect', ids: ids(nodes), index: row.index, patch: { [key]: value } };
}

/** A shadow colour from a hex field or picker, keeping the shown alpha (opaque when mixed). */
export function effectColorCommand(
  nodes: readonly NodeV8[],
  row: EffectRow,
  hex: string,
): Command | null {
  const color = parseHex(hex, row.color.state === 'one' ? row.color.value.a : 1);
  if (color === null) return null;
  return { type: 'setEffect', ids: ids(nodes), index: row.index, patch: { color } };
}

/** The shadow colour's opacity in percent, as the field shows it, or null when mixed. */
export const opacityText = (color: Common<Color>): string | null =>
  color.state === 'one' ? numberText(Math.round(color.value.a * 1000) / 10) : null;

/** An opacity field's commit (0 to 100 %), keeping the shown colour; null when not a value. */
export function effectOpacityCommand(
  nodes: readonly NodeV8[],
  row: EffectRow,
  text: string,
): Command | null {
  if (row.color.state !== 'one') return null;
  const percent = parseNumber(text.replace(/%\s*$/u, ''), 0, 100);
  if (percent === null) return null;
  return {
    type: 'setEffect',
    ids: ids(nodes),
    index: row.index,
    patch: { color: { ...row.color.value, a: percent / 100 } },
  };
}

/**
 * The effects a node draws (E41-S10): an instance without effects of its own draws with its
 * symbol's.
 */
function drawnEffects(document: DocumentV8, node: NodeV8): readonly Effect[] {
  if (node.type !== 'instance' || node.effects.length > 0) return node.effects;
  const source = Object.hasOwn(document.nodes, node.symbol)
    ? document.nodes[node.symbol]
    : undefined;
  return source?.type === 'symbol' ? source.effects : node.effects;
}

/**
 * V-36 section 5.3: whether a background blur at `row` shows only outside groups with opacity or
 * effects, so the panel notes it does not show: true when any selected node whose effect at the
 * row's index is a background blur is drawn inside a layer: an ancestor with opacity below 1 or
 * with a visible effect it draws (E41-S10: an instance without effects of its own draws with its
 * symbol's). Inside a symbol, each instance of it is such an ancestor too (the symbol's content
 * draws inside each instance), with its own ancestors. The renderer draws a background blur only
 * for a root composited in the main pass and counts the others in `backgroundBlurSkipped`.
 */
export function backgroundBlurNested(
  document: DocumentV8,
  nodes: readonly NodeV8[],
  row: EffectRow,
): boolean {
  const seen = new Set<string>();
  // V-35 (V35-K3): a container or instance with a blend mode other than pass-through is a layer.
  const layered = (node: NodeV8) =>
    node.opacity < 1 ||
    drawnEffects(document, node).some((effect) => effect.visible) ||
    (node.type !== 'symbol' && 'children' in node && node.blendMode !== 'passThrough') ||
    (node.type === 'instance' && node.blendMode !== 'passThrough');
  // Whether any ancestor of the node named `parent` (itself included) draws as a layer.
  const nestedBelow = (parent: string): boolean => {
    for (let id = parent; Object.hasOwn(document.nodes, id) && !seen.has(id);) {
      seen.add(id);
      const ancestor = document.nodes[id]!;
      if (layered(ancestor)) return true;
      if (ancestor.type === 'symbol') {
        for (const node of Object.values(document.nodes)) {
          if (node.type !== 'instance' || node.symbol !== id) continue;
          if (layered(node) || nestedBelow(node.parent)) return true;
        }
      }
      id = ancestor.parent;
    }
    return false;
  };
  return nodes.some(
    (node) => node.effects[row.index]?.kind === 'backgroundBlur' && nestedBelow(node.parent),
  );
}

/** The note shown under a background-blur row that `backgroundBlurNested` marks. */
export const BACKGROUND_BLUR_NESTED_NOTE =
  'Background blur shows only outside groups with opacity or effects';

/** The notice for `editor.effect-limit`, or null for any other result. */
export function effectNotice(result: CommandResult | null): string | null {
  return result !== null && !result.ok && result.code === 'editor.effect-limit'
    ? 'A layer takes at most 8 effects, at most one layer blur and one background blur'
    : null;
}
