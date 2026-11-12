import {
  MAX_EFFECTS,
  validateNode,
  type DocumentV8,
  type Effect,
  type NodeV8,
} from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import {
  nodeOf,
  success,
  uniqueIds,
  type CustomRules,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { deepFreeze } from './freeze.js';
import { documentTree, nodePath, pageOf } from './tree.js';
import type { DocumentCommand } from './types.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), section 6, and V-36 contract
// (docs/plans/viz-v36-inner-shadow-background-blur-contract.md), section 6: the effect commands.
// `addEffect` appends a default effect to each node, `setEffect` patches the effect at one index
// of each node that has one there (a visible toggle is a `visible` patch), and `removeEffect`
// removes it. Each is one transaction (one undo step); a change of no value records no step.

type Finish = (draft: Draft) => DocumentV8 | Failure;

/** E41 contract, section 6: the defaults `addEffect` appends. */
export const DEFAULT_DROP_SHADOW: Effect = deepFreeze({
  kind: 'dropShadow',
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 0,
  offsetY: 4,
  radius: 8,
});
export const DEFAULT_LAYER_BLUR: Effect = deepFreeze({
  kind: 'layerBlur',
  visible: true,
  radius: 4,
});
/** V-36 contract, section 6: Figma's defaults for the two kinds V-36 adds. */
export const DEFAULT_INNER_SHADOW: Effect = deepFreeze({
  kind: 'innerShadow',
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 0,
  offsetY: 4,
  radius: 4,
});
export const DEFAULT_BACKGROUND_BLUR: Effect = deepFreeze({
  kind: 'backgroundBlur',
  visible: true,
  radius: 4,
});

const DEFAULTS: Readonly<Record<Effect['kind'], Effect>> = {
  dropShadow: DEFAULT_DROP_SHADOW,
  innerShadow: DEFAULT_INNER_SHADOW,
  layerBlur: DEFAULT_LAYER_BLUR,
  backgroundBlur: DEFAULT_BACKGROUND_BLUR,
};

const SHADOW_KEYS = ['kind', 'visible', 'color', 'offsetX', 'offsetY', 'radius'] as const;
const BLUR_KEYS = ['kind', 'visible', 'radius'] as const;

/** The fields each kind's patch may set; `kind` within the family (V-36 contract, section 6). */
const PATCH_KEYS: Readonly<Record<Effect['kind'], readonly string[]>> = {
  dropShadow: SHADOW_KEYS,
  innerShadow: SHADOW_KEYS,
  layerBlur: BLUR_KEYS,
  backgroundBlur: BLUR_KEYS,
};

/** The family of each kind: the kinds a `kind` patch may turn it into. */
const FAMILY: Readonly<Record<Effect['kind'], 'shadow' | 'blur'>> = {
  dropShadow: 'shadow',
  innerShadow: 'shadow',
  layerBlur: 'blur',
  backgroundBlur: 'blur',
};

const isKind = (value: unknown): value is Effect['kind'] =>
  typeof value === 'string' && Object.hasOwn(FAMILY, value);

/** E41-S3 and V36-S2: at most one layer blur and one background blur. */
function overBlurLimit(effects: readonly Effect[]): boolean {
  const count = (kind: Effect['kind']) => effects.filter((entry) => entry.kind === kind).length;
  return count('layerBlur') > 1 || count('backgroundBlur') > 1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The listed nodes, all on the active page, or the failure `setStyle` gives. */
function targets(
  document: DocumentV8,
  ids: unknown,
  context: EditContext,
): readonly NodeV8[] | Failure {
  const unique = uniqueIds(ids);
  if (unique === null || unique.length === 0) return fail('editor.invalid-command', '/ids');
  const tree = documentTree(document);
  if (
    unique.some(
      (id) => nodeOf(document, id) === undefined || pageOf(tree, id) !== context.activePage,
    )
  ) {
    return fail('editor.unknown-node');
  }
  return unique.map((id) => document.nodes[id]!);
}

/** Validates each changed node and commits them in one transaction. */
function commit(
  document: DocumentV8,
  changed: readonly NodeV8[],
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const checked: NodeV8[] = [];
  for (const node of changed) {
    const result = validateNode(node);
    if (!result.ok) return fail(result.code, nodePath(node.id, result.path));
    const rejected = custom.check(deepFreeze(result.node));
    if (rejected !== null) return fail(rejected.code, nodePath(node.id, rejected.path));
    // A change of no value (compared after the model's normalization) records no step.
    if (JSON.stringify(result.node.effects) === JSON.stringify(document.nodes[node.id]!.effects)) {
      continue;
    }
    checked.push(result.node);
  }
  if (checked.length === 0) return { ok: true, document, touched: [], created: [] };
  const draft = new Draft(document);
  for (const node of checked) draft.setChecked(node, true);
  return success(finish(draft), draft, []);
}

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** `addEffect`: E41-S3's and V36-S2's limits refuse with `editor.effect-limit` and no change. */
export function addEffect(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'addEffect' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  const kind: unknown = command.kind;
  if (!isKind(kind)) return fail('editor.invalid-command', '/kind');
  const effect = DEFAULTS[kind];
  for (const node of nodes) {
    if (node.effects.length >= MAX_EFFECTS || overBlurLimit([...node.effects, effect])) {
      return fail('editor.effect-limit', nodePath(node.id, '/effects'));
    }
  }
  return commit(
    document,
    nodes.map((node) => ({ ...node, effects: [...node.effects, effect] })),
    custom,
    finish,
  );
}

/**
 * `setEffect`: the patch applies to the effect at `index` of each listed node that has one. A
 * key no such effect takes, or no listed node with an effect at `index`, is
 * `editor.invalid-command` (`/patch/<key>`, `/index`); a value out of S3's range fails the
 * model's check at the node's effect. A `kind` patch (V-36 contract, section 6) applies to the
 * effects in its family and leaves the others unchanged; one that would give a node a second
 * blur of one kind refuses the whole command with `editor.effect-limit` at that node.
 */
export function setEffect(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setEffect' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  if (!isIndex(command.index)) return fail('editor.invalid-command', '/index');
  const patch: unknown = command.patch;
  if (!isPlainRecord(patch) || Object.keys(patch).length === 0) {
    return fail('editor.invalid-command', '/patch');
  }
  const index = command.index;
  const holders = nodes.filter((node) => index < node.effects.length);
  if (holders.length === 0) return fail('editor.invalid-command', '/index');
  const kind: unknown = patch.kind;
  if (Object.hasOwn(patch, 'kind') && !isKind(kind)) {
    return fail('editor.invalid-command', '/patch/kind');
  }
  // With a `kind` patch only the effects in its family take the patch.
  const patched = isKind(kind)
    ? holders.filter((node) => FAMILY[node.effects[index]!.kind] === FAMILY[kind])
    : holders;
  if (patched.length === 0) return fail('editor.invalid-command', '/patch/kind');
  for (const key of Object.keys(patch)) {
    if (!patched.some((node) => PATCH_KEYS[node.effects[index]!.kind].includes(key))) {
      return fail(
        'editor.invalid-command',
        `/patch/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      );
    }
  }
  const changed: NodeV8[] = [];
  for (const node of patched) {
    const before = node.effects[index]!;
    const keys = PATCH_KEYS[before.kind].filter((key) => Object.hasOwn(patch, key));
    const after = { ...before, ...Object.fromEntries(keys.map((key) => [key, patch[key]])) };
    if (
      keys.every(
        (key) =>
          JSON.stringify(after[key as keyof typeof after]) ===
          JSON.stringify(before[key as keyof typeof before]),
      )
    ) {
      continue;
    }
    const effects = node.effects.map((entry, i) => (i === index ? (after as Effect) : entry));
    if (overBlurLimit(effects)) return fail('editor.effect-limit', nodePath(node.id, '/effects'));
    changed.push({ ...node, effects });
  }
  return commit(document, changed, custom, finish);
}

/** `removeEffect`: removes the effect at `index` of each listed node that has one. */
export function removeEffect(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'removeEffect' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  if (!isIndex(command.index)) return fail('editor.invalid-command', '/index');
  const index = command.index;
  const holders = nodes.filter((node) => index < node.effects.length);
  if (holders.length === 0) return fail('editor.invalid-command', '/index');
  return commit(
    document,
    holders.map((node) => ({ ...node, effects: node.effects.filter((_, i) => i !== index) })),
    custom,
    finish,
  );
}
