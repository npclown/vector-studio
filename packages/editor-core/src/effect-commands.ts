import {
  MAX_EFFECTS,
  validateNode,
  type DocumentV7,
  type Effect,
  type NodeV7,
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

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), section 6: the effect commands.
// `addEffect` appends a default effect to each node, `setEffect` patches the effect at one index
// of each node that has one there (a visible toggle is a `visible` patch), and `removeEffect`
// removes it. Each is one transaction (one undo step); a change of no value records no step.

type Finish = (draft: Draft) => DocumentV7 | Failure;

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

/** The fields each kind's patch may set. */
const PATCH_KEYS: Readonly<Record<Effect['kind'], readonly string[]>> = {
  dropShadow: ['visible', 'color', 'offsetX', 'offsetY', 'radius'],
  layerBlur: ['visible', 'radius'],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The listed nodes, all on the active page, or the failure `setStyle` gives. */
function targets(
  document: DocumentV7,
  ids: unknown,
  context: EditContext,
): readonly NodeV7[] | Failure {
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
  document: DocumentV7,
  changed: readonly NodeV7[],
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const checked: NodeV7[] = [];
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

/** `addEffect`: E41-S3's limits refuse with `editor.effect-limit` and no change. */
export function addEffect(
  document: DocumentV7,
  command: Extract<DocumentCommand, { type: 'addEffect' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  const effect =
    command.kind === 'dropShadow'
      ? DEFAULT_DROP_SHADOW
      : command.kind === 'layerBlur'
        ? DEFAULT_LAYER_BLUR
        : null;
  if (effect === null) return fail('editor.invalid-command', '/kind');
  for (const node of nodes) {
    if (
      node.effects.length >= MAX_EFFECTS ||
      (effect.kind === 'layerBlur' && node.effects.some((entry) => entry.kind === 'layerBlur'))
    ) {
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
 * model's check at the node's effect.
 */
export function setEffect(
  document: DocumentV7,
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
  for (const key of Object.keys(patch)) {
    if (!holders.some((node) => PATCH_KEYS[node.effects[index]!.kind].includes(key))) {
      return fail(
        'editor.invalid-command',
        `/patch/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      );
    }
  }
  const changed: NodeV7[] = [];
  for (const node of holders) {
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
    changed.push({ ...node, effects });
  }
  return commit(document, changed, custom, finish);
}

/** `removeEffect`: removes the effect at `index` of each listed node that has one. */
export function removeEffect(
  document: DocumentV7,
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
