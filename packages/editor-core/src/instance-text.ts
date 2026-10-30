import {
  validateNode,
  type DocumentV6,
  type InstanceNodeV5,
  type TextOverride,
} from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import { sameRuns } from './expansion.js';
import { nodeOf, success, type EditContext, type EditResult } from './edit-support.js';
import { MIN_AUTHORED_TEXT_SIZE } from './text.js';
import { ancestors, documentTree } from './tree.js';
import type { DocumentCommand } from './types.js';

// Instance text overrides (MVP M6a contract, section 9, M7-T3): `setInstanceText` and
// `clearInstanceText`, and the key remap a copy of an instance takes with a copy of its source.
// An override holds runs only, in the source's space; the expansion applies it (`expansion.ts`)
// and `Draft.finish` drops keys left without their text node. No port is needed.

type Finish = (draft: Draft) => DocumentV6 | Failure;
type InstanceTextCommand<T extends 'setInstanceText' | 'clearInstanceText'> = Extract<
  DocumentCommand,
  { type: T }
>;

/**
 * The overrides of a copied instance whose source is copied too: each key mapped to the copy of
 * its text node; a key without a copy is dropped (none in a valid document).
 */
export function remappedOverrides(
  overrides: InstanceNodeV5['textOverrides'],
  copyOf: ReadonlyMap<string, string>,
): Record<string, TextOverride> {
  const entries: [string, TextOverride][] = [];
  for (const key of Object.keys(overrides)) {
    const copy = copyOf.get(key);
    if (copy !== undefined) entries.push([copy, overrides[key]!]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // fromEntries defines own properties, so a "__proto__" ID stays data.
  return Object.fromEntries(entries);
}

/** The overrides with `key` set to `value` (or removed when null), keys in code unit order. */
function withKey(
  overrides: InstanceNodeV5['textOverrides'],
  key: string,
  value: TextOverride | null,
): Record<string, TextOverride> {
  const keys = Object.keys(overrides).filter((name) => name !== key);
  if (value !== null) keys.push(key);
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(
    keys.map((name) => [name, name === key ? value! : overrides[name]!] as const),
  );
}

/** `id` names an instance: `editor.unknown-node`, then `editor.not-an-instance` (no path). */
function instanceOf(document: DocumentV6, id: string): InstanceNodeV5 | Failure {
  const node = nodeOf(document, id);
  if (node === undefined) return fail('editor.unknown-node');
  if (node.type !== 'instance') return fail('editor.not-an-instance');
  return node;
}

/** Whether `id` is a text node of the subtree of the instance's source. */
function isSourceText(document: DocumentV6, instance: InstanceNodeV5, id: string): boolean {
  const node = nodeOf(document, id);
  if (node?.type !== 'text') return false;
  return ancestors(documentTree(document), id).some((up) => up.id === instance.symbol);
}

function isFailure(value: object): value is Failure {
  return 'ok' in value;
}

/** The command's document with `instance` replaced, as one step; unchanged gives no step. */
function written(
  document: DocumentV6,
  instance: InstanceNodeV5,
  textOverrides: Record<string, TextOverride>,
  finish: Finish,
): EditResult {
  const before = Object.keys(instance.textOverrides);
  const after = Object.keys(textOverrides);
  const unchanged =
    before.length === after.length &&
    before.every(
      (key, i) => key === after[i] && instance.textOverrides[key] === textOverrides[key],
    );
  if (unchanged) return { ok: true, document, touched: [], created: [] };
  const draft = new Draft(document);
  draft.setChecked({ ...instance, textOverrides }, true);
  return success(finish(draft), draft, []);
}

/**
 * `setInstanceText { id, node, runs }` (M7-T3): the checks in order are the shape
 * (`editor.invalid-command` at `/id` or `/node`), `editor.unknown-node`, `editor.not-an-instance`,
 * `node` a text node of the source's subtree (`editor.not-a-text-node` at `/node`), the model's
 * rules on the runs (`document.invalid-field` at `/runs...`), then the authored size floor
 * (`editor.invalid-command` at `/runs/<k>/size`). Runs equal to the source node's remove the key;
 * a command that changes nothing records no step.
 */
export function setInstanceText(
  document: DocumentV6,
  command: InstanceTextCommand<'setInstanceText'>,
  _context: EditContext,
  finish: Finish,
): EditResult {
  const { id, node, runs } = command as Record<string, unknown>;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (typeof node !== 'string') return fail('editor.invalid-command', '/node');
  const instance = instanceOf(document, id);
  if (isFailure(instance)) return instance;
  if (!isSourceText(document, instance, node)) return fail('editor.not-a-text-node', '/node');
  // The model's rules on the runs, as a load reads an override (M6a-S1 to S4).
  const prefix = `/textOverrides/${node.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  const checked = validateNode({ ...instance, textOverrides: { [node]: { runs } } });
  if (!checked.ok) {
    const path = checked.path.startsWith(prefix) ? checked.path.slice(prefix.length) : '/runs';
    return fail(checked.code, path);
  }
  const valid = (checked.node as InstanceNodeV5).textOverrides[node]!;
  const small = valid.runs.findIndex((run) => run.size < MIN_AUTHORED_TEXT_SIZE);
  if (small >= 0) return fail('editor.invalid-command', `/runs/${small}/size`);
  const source = document.nodes[node]!;
  const same = source.type === 'text' && sameRuns(source.runs, valid.runs);
  const current = Object.hasOwn(instance.textOverrides, node)
    ? instance.textOverrides[node]
    : undefined;
  if (current !== undefined && sameRuns(current.runs, valid.runs)) {
    return { ok: true, document, touched: [], created: [] };
  }
  return written(
    document,
    instance,
    withKey(instance.textOverrides, node, same ? null : valid),
    finish,
  );
}

/**
 * `clearInstanceText { id, node? }` (M7-T3): removes the override of `node`, or every override
 * without it. The checks in order are the shape (`editor.invalid-command` at `/id` or `/node`),
 * `editor.unknown-node`, `editor.not-an-instance`, then `node` a text node of the source's
 * subtree (`editor.not-a-text-node` at `/node`). A command that changes nothing records no step.
 */
export function clearInstanceText(
  document: DocumentV6,
  command: InstanceTextCommand<'clearInstanceText'>,
  _context: EditContext,
  finish: Finish,
): EditResult {
  const { id, node } = command as Record<string, unknown>;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (node !== undefined && typeof node !== 'string') {
    return fail('editor.invalid-command', '/node');
  }
  const instance = instanceOf(document, id);
  if (isFailure(instance)) return instance;
  if (node === undefined) return written(document, instance, {}, finish);
  if (!isSourceText(document, instance, node)) return fail('editor.not-a-text-node', '/node');
  return written(document, instance, withKey(instance.textOverrides, node, null), finish);
}
