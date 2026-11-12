import type { Color, Command, CommandResult, DocumentV8, NodeV8 } from '@vector-studio/react';
import { numberText, parseHex, parseNumber, type Common } from './appearance-model.js';

// E41-U7 (E41 contract, section 6): the property panel's "Effects" section. Each row is one
// effect index; with several nodes selected a row covers every selected node that has an effect
// at that index ("holders"), and a field shows "mixed" where they differ. Add appends to each
// selected node (`addEffect`); a field edit patches the row's index on each holder
// (`setEffect`, which applies a key only to holders whose kind takes it); remove removes it
// (`removeEffect`). One committed value is one command and one undo step.

export type EffectKind = 'dropShadow' | 'layerBlur' | 'mixed';

/** One effect index over the selected nodes. */
export type EffectRow = Readonly<{
  index: number;
  /** The kind the holders share, or 'mixed'. */
  kind: EffectKind;
  /** Whether any holder is a drop shadow (the colour and offset fields then show). */
  shadow: boolean;
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
    const shadows = effects.flatMap((effect) => (effect.kind === 'dropShadow' ? [effect] : []));
    const kind = commonOf(effects, (effect) => effect.kind);
    rows.push({
      index,
      kind: kind.state === 'one' ? kind.value : 'mixed',
      shadow: shadows.length > 0,
      visible: commonOf(effects, (effect) => effect.visible),
      color: commonOf(shadows, (effect) => effect.color),
      offsetX: commonOf(shadows, (effect) => effect.offsetX),
      offsetY: commonOf(shadows, (effect) => effect.offsetY),
      radius: commonOf(effects, (effect) => effect.radius),
    });
  }
  return rows;
}

/** A row's label as the panel shows it. */
export const effectLabel = (kind: EffectKind): string =>
  kind === 'dropShadow' ? 'Drop shadow' : kind === 'layerBlur' ? 'Layer blur' : 'Mixed';

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

const ids = (nodes: readonly NodeV8[]) => nodes.map((node) => node.id);

export const addEffectCommand = (
  nodes: readonly NodeV8[],
  kind: 'dropShadow' | 'layerBlur',
): Command => ({ type: 'addEffect', ids: ids(nodes), kind });

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

/** The notice for `editor.effect-limit`, or null for any other result. */
export function effectNotice(result: CommandResult | null): string | null {
  return result !== null && !result.ok && result.code === 'editor.effect-limit'
    ? 'A layer takes at most 8 effects and one layer blur'
    : null;
}
