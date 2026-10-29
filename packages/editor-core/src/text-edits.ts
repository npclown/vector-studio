import { validateNode, type DocumentV5, type TextNode } from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import { nodeOf, success, uniqueIds, type EditContext, type EditResult } from './edit-support.js';
import {
  isAuto,
  MIN_AUTHORED_TEXT_SIZE,
  refitFrame,
  replaceText,
  restyleText,
  splitsPair,
  nodeText,
} from './text.js';
import { nodePath } from './tree.js';
import type { DocumentCommand } from './types.js';

// The text commands of the MVP M6a contract, section 6.1, except `createText`, which creation
// owns (`edits.ts`). Checks run in the section 6.1 order: the command's shape
// (`editor.invalid-command` at the field), `editor.unknown-node`, `editor.not-a-text-node`, the
// offsets (`editor.invalid-text-range`), the model's rules on the result (at the node's paths),
// the authored size floor, then `editor.no-text-layout`; the structural rules follow in
// `success`. A node in an auto mode is refit with the growth anchor by `Draft.finish`.

type Finish = (draft: Draft) => DocumentV5 | Failure;
type TextCommand<T extends DocumentCommand['type']> = Extract<DocumentCommand, { type: T }>;

const STYLE_KEYS: readonly string[] = ['family', 'size', 'color'];
const PROP_KEYS = ['sizing', 'align', 'letterSpacing', 'lineHeight'] as const;

/** `id` names a text node: `editor.unknown-node`, then `editor.not-a-text-node` at `path`. */
function textNodeOf(document: DocumentV5, id: string, path: string): TextNode | Failure {
  const node = nodeOf(document, id);
  if (node === undefined) return fail('editor.unknown-node');
  if (node.type !== 'text') return fail('editor.not-a-text-node', path);
  return node;
}

/**
 * The offsets of a range: integers with `0 ≤ start ≤ end ≤ length`, neither between the two
 * halves of a surrogate pair (M6a-Q17 (a)); `editor.invalid-text-range` at `/start` or `/end`.
 */
function rangeFailure(node: TextNode, start: number, end: number): Failure | null {
  const text = nodeText(node.runs);
  if (!Number.isInteger(start) || start < 0 || start > text.length || splitsPair(text, start)) {
    return fail('editor.invalid-text-range', '/start');
  }
  if (!Number.isInteger(end) || end < start || end > text.length || splitsPair(text, end)) {
    return fail('editor.invalid-text-range', '/end');
  }
  return null;
}

/** The model's rules on the edited node, at its paths, as `setNodeProps` reports them. */
function validated(candidate: TextNode): TextNode | Failure {
  const result = validateNode(candidate);
  if (!result.ok) return fail(result.code, nodePath(candidate.id, result.path));
  return result.node as TextNode;
}

/** Commits the edited node, marked for the refit when it is in an auto mode. */
function written(
  document: DocumentV5,
  node: TextNode,
  context: EditContext,
  finish: Finish,
): EditResult {
  if (isAuto(node) && context.layout === undefined) return fail('editor.no-text-layout');
  const draft = new Draft(document);
  draft.setChecked(node, true);
  draft.markTextRefit(node.id);
  return success(finish(draft), draft, []);
}

function isFailure(value: object): value is Failure {
  return 'ok' in value;
}

/** `setText` (section 6.1). */
export function setText(
  document: DocumentV5,
  command: TextCommand<'setText'>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { id, start, end, text } = command as Record<string, unknown>;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (typeof start !== 'number') return fail('editor.invalid-command', '/start');
  if (typeof end !== 'number') return fail('editor.invalid-command', '/end');
  if (typeof text !== 'string') return fail('editor.invalid-command', '/text');
  const node = textNodeOf(document, id, '/id');
  if (isFailure(node)) return node;
  const range = rangeFailure(node, start, end);
  if (range !== null) return range;
  const next = validated({ ...node, runs: replaceText(node.runs, start, end, text) });
  if (isFailure(next)) return next;
  return written(document, next, context, finish);
}

/** `setTextStyle` (section 6.1). */
export function setTextStyle(
  document: DocumentV5,
  command: TextCommand<'setTextStyle'>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { id, start, end, style } = command as Record<string, unknown>;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (typeof start !== 'number') return fail('editor.invalid-command', '/start');
  if (typeof end !== 'number') return fail('editor.invalid-command', '/end');
  if (typeof style !== 'object' || style === null || Array.isArray(style)) {
    return fail('editor.invalid-command', '/style');
  }
  const keys = Object.keys(style);
  if (keys.length === 0) return fail('editor.invalid-command', '/style');
  for (const key of keys) {
    if (!STYLE_KEYS.includes(key)) return fail('editor.invalid-command', `/style/${key}`);
  }
  const node = textNodeOf(document, id, '/id');
  if (isFailure(node)) return node;
  const range = rangeFailure(node, start, end);
  if (range !== null) return range;
  // A non-empty range, or `0, 0` on an empty node.
  if (start === end && nodeText(node.runs).length > 0) {
    return fail('editor.invalid-text-range', '/end');
  }
  const given = Object.fromEntries(
    keys.map((key) => [key, (style as Record<string, unknown>)[key]]),
  );
  const next = validated({
    ...node,
    runs: restyleText(node.runs, start, end, given),
  });
  if (isFailure(next)) return next;
  // The authored size floor (M6a-Q19), after the model's rules.
  if (keys.includes('size') && (given.size as number) < MIN_AUTHORED_TEXT_SIZE) {
    return fail('editor.invalid-command', '/style/size');
  }
  return written(document, next, context, finish);
}

/** `setTextProps` (section 6.1): at least one prop; `autoWidth` takes its width from the layout. */
export function setTextProps(
  document: DocumentV5,
  command: TextCommand<'setTextProps'>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const raw = command as Record<string, unknown>;
  if (typeof raw.id !== 'string') return fail('editor.invalid-command', '/id');
  const props = Object.fromEntries(
    PROP_KEYS.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]),
  );
  if (Object.keys(props).length === 0) return fail('editor.invalid-command');
  const node = textNodeOf(document, raw.id, '/id');
  if (isFailure(node)) return node;
  const next = validated({ ...node, ...props });
  if (isFailure(next)) return next;
  return written(document, next, context, finish);
}

/**
 * `refitText` (section 6.1): the auto dimensions of the listed text nodes, by default every text
 * node of the document, refit as one step; a node whose frame does not change is skipped, and
 * with no change the document itself is returned, which the editor records as no step.
 */
export function refitText(
  document: DocumentV5,
  command: TextCommand<'refitText'>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const raw: unknown = command.ids;
  let ids: readonly string[];
  if (raw === undefined) {
    ids = Object.keys(document.nodes).filter((id) => document.nodes[id]!.type === 'text');
  } else {
    const listed = uniqueIds(raw);
    if (listed === null) return fail('editor.invalid-command', '/ids');
    ids = listed;
  }
  if (ids.some((id) => nodeOf(document, id) === undefined)) return fail('editor.unknown-node');
  const nodes: TextNode[] = [];
  for (const [k, id] of ids.entries()) {
    const node = textNodeOf(document, id, `/ids/${k}`);
    if (isFailure(node)) return node;
    nodes.push(node);
  }
  const auto = nodes.filter(isAuto);
  const unchanged: EditResult = { ok: true, document, touched: [], created: [] };
  if (auto.length === 0) return unchanged;
  const layout = context.layout;
  if (layout === undefined) return fail('editor.no-text-layout');
  const draft = new Draft(document);
  for (const node of auto) {
    const frame = refitFrame(node, layout(node));
    if (frame !== node.frame) draft.set({ ...node, frame });
  }
  if (draft.touched.size === 0) return unchanged;
  return success(finish(draft), draft, []);
}
