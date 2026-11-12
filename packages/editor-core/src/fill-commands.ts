import {
  MAX_FILLS,
  validateNode,
  type DocumentV8,
  type Fill,
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
import { DEFAULT_RECTANGLE_FILL } from './edits.js';
import { paintFill } from './fills.js';
import { deepFreeze } from './freeze.js';
import { documentTree, nodePath, pageOf } from './tree.js';
import type { DocumentCommand } from './types.js';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-C1: the fill commands.
// `addFill` appends a default fill to each node that takes fills, `setFill` patches the fill at
// one index of each listed node that has one, `removeFill` removes it and `moveFill` reorders.
// Each is one transaction (one undo step); a change of no value records no step.

type Finish = (draft: Draft) => DocumentV8 | Failure;
type Filled = Extract<NodeV8, { fills: readonly Fill[] }>;

const PATCH_KEYS = ['paint', 'visible', 'opacity', 'blendMode'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The listed nodes that take fills, all listed nodes on the active page, or a failure. */
function targets(
  document: DocumentV8,
  ids: unknown,
  context: EditContext,
): readonly Filled[] | Failure {
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
  const filled = unique
    .map((id) => document.nodes[id]!)
    .filter((node): node is Filled => 'fills' in node);
  if (filled.length === 0) return fail('editor.invalid-command', '/ids');
  return filled;
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
    const before = document.nodes[node.id] as Filled;
    if (JSON.stringify((result.node as Filled).fills) === JSON.stringify(before.fills)) continue;
    checked.push(result.node);
  }
  if (checked.length === 0) return { ok: true, document, touched: [], created: [] };
  const draft = new Draft(document);
  for (const node of checked) draft.setChecked(node, true);
  return success(finish(draft), draft, []);
}

/** `addFill`: past V35-S3's 16 fills it refuses with `editor.fill-limit` and no change. */
export function addFill(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'addFill' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  for (const node of nodes) {
    if (node.fills.length >= MAX_FILLS) {
      return fail('editor.fill-limit', nodePath(node.id, '/fills'));
    }
  }
  const fill = paintFill(DEFAULT_RECTANGLE_FILL);
  return commit(
    document,
    nodes.map((node) => ({ ...node, fills: [...node.fills, fill] }) as NodeV8),
    custom,
    finish,
  );
}

/**
 * `setFill`: the patch applies to the fill at `index` of each listed node that has one. An
 * unknown key, or no listed node with a fill at `index`, is `editor.invalid-command`
 * (`/patch/<key>`, `/index`); a value out of S3's range fails the model's check at the fill.
 */
export function setFill(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setFill' }>,
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
  for (const key of Object.keys(patch)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) {
      return fail(
        'editor.invalid-command',
        `/patch/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      );
    }
  }
  const index = command.index;
  const holders = nodes.filter((node) => index < node.fills.length);
  if (holders.length === 0) return fail('editor.invalid-command', '/index');
  return commit(
    document,
    holders.map(
      (node) =>
        ({
          ...node,
          fills: node.fills.map((fill, i) => (i === index ? { ...fill, ...patch } : fill)),
        }) as NodeV8,
    ),
    custom,
    finish,
  );
}

/** `removeFill`: removes the fill at `index` of each listed node that has one. */
export function removeFill(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'removeFill' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  if (!isIndex(command.index)) return fail('editor.invalid-command', '/index');
  const index = command.index;
  const holders = nodes.filter((node) => index < node.fills.length);
  if (holders.length === 0) return fail('editor.invalid-command', '/index');
  return commit(
    document,
    holders.map((node) => ({ ...node, fills: node.fills.filter((_, i) => i !== index) }) as NodeV8),
    custom,
    finish,
  );
}

/**
 * `moveFill`: moves the fill at `from` to `to` (both indices into the list, bottom first) on
 * each listed node with both indices in range.
 */
export function moveFill(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'moveFill' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  if (!isIndex(command.from)) return fail('editor.invalid-command', '/from');
  if (!isIndex(command.to)) return fail('editor.invalid-command', '/to');
  const { from, to } = command;
  const holders = nodes.filter((node) => from < node.fills.length && to < node.fills.length);
  if (holders.length === 0) return fail('editor.invalid-command', '/from');
  return commit(
    document,
    holders.map((node) => {
      const fills = [...node.fills];
      const [moved] = fills.splice(from, 1);
      fills.splice(to, 0, moved!);
      return { ...node, fills } as NodeV8;
    }),
    custom,
    finish,
  );
}
