import {
  validateNode,
  type AutoLayout,
  type DocumentV8,
  type LayoutFields,
  type LayoutSizing,
  type NodeV8,
} from '@vector-studio/model';
import { autoLayoutOf, hugSizing, inferAutoLayout, layoutSizingOf, unhug } from './auto-layout.js';
import { Draft, fail, withSizing, type Failure } from './draft.js';
import {
  nodeOf,
  success,
  uniqueIds,
  type CustomRules,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { deepFreeze } from './freeze.js';
import { rotatedBounds } from './geometry.js';
import { documentTree, nodePath, pageOf } from './tree.js';
import type { DocumentCommand } from './types.js';

// V-34 contract (docs/plans/viz-v34-auto-layout-contract.md), section 5: `setLayout`,
// `addAutoLayout` and `removeAutoLayout`. Each is one transaction (one undo step); a change of
// no value records no step. The layout itself runs in the draft's `finish` (section 4.3).

type Finish = (draft: Draft) => DocumentV8 | Failure;
type LayoutNode = NodeV8 & LayoutFields;

const LAYOUT_KEYS = ['direction', 'gap', 'padding', 'primaryAlign', 'counterAlign'] as const;
const AXES = ['horizontal', 'vertical'] as const;

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

/** `node` without `autoLayout`, its hug axes fixed (section 4.2). */
export function withoutAutoLayout(node: NodeV8): NodeV8 {
  const copy = { ...node } as LayoutNode & { autoLayout?: unknown };
  delete copy.autoLayout;
  return withSizing(copy, unhug(layoutSizingOf(node)));
}

/** Section 4.2's text rules for a new `layoutSizing` of a text node. */
function textSizingRule(node: NodeV8, sizing: LayoutSizing): NodeV8 {
  if (node.type !== 'text') return node;
  let mode = node.sizing;
  if (sizing.horizontal === 'fill' && mode === 'autoWidth') mode = 'autoHeight';
  if (sizing.vertical === 'fill' && mode !== 'fixed') mode = 'fixed';
  return mode === node.sizing ? node : { ...node, sizing: mode };
}

/** Validates the changed nodes and commits them in one transaction. */
function commit(
  document: DocumentV8,
  changed: readonly NodeV8[],
  custom: CustomRules,
  finish: Finish,
  setup?: (draft: Draft) => void,
): EditResult {
  const checked: NodeV8[] = [];
  for (const node of changed) {
    const result = validateNode(node);
    if (!result.ok) return fail(result.code, nodePath(node.id, result.path));
    const rejected = custom.check(deepFreeze(result.node));
    if (rejected !== null) return fail(rejected.code, nodePath(node.id, rejected.path));
    if (JSON.stringify(result.node) === JSON.stringify(document.nodes[node.id])) continue;
    checked.push(result.node);
  }
  if (checked.length === 0) return { ok: true, document, touched: [], created: [] };
  const draft = new Draft(document);
  for (const node of checked) draft.setChecked(node, true);
  setup?.(draft);
  return success(finish(draft), draft, []);
}

/**
 * `setLayout` (section 5): `autoLayout` patches the listed frames that have it (others are
 * unchanged; `null` removes it), `layoutSizing` patches every listed node with section 4.2's
 * text rules; a result the model refuses refuses the command.
 */
export function setLayout(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setLayout' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  const layout: unknown = command.autoLayout;
  const sizing: unknown = command.layoutSizing;
  if (layout === undefined && sizing === undefined) return fail('editor.invalid-command');
  if (layout !== undefined && layout !== null) {
    if (!isPlainRecord(layout) || Object.keys(layout).length === 0) {
      return fail('editor.invalid-command', '/autoLayout');
    }
    for (const key of Object.keys(layout)) {
      if (!(LAYOUT_KEYS as readonly string[]).includes(key)) {
        return fail('editor.invalid-command', `/autoLayout/${key}`);
      }
    }
  }
  if (sizing !== undefined) {
    if (!isPlainRecord(sizing) || Object.keys(sizing).length === 0) {
      return fail('editor.invalid-command', '/layoutSizing');
    }
    for (const key of Object.keys(sizing)) {
      if (!(AXES as readonly string[]).includes(key)) {
        return fail('editor.invalid-command', `/layoutSizing/${key}`);
      }
    }
  }
  const changed: NodeV8[] = [];
  for (const original of nodes) {
    let node = original;
    const current = autoLayoutOf(node);
    if (layout === null) {
      if (current !== null) node = withoutAutoLayout(node);
    } else if (layout !== undefined && current !== null) {
      node = { ...node, autoLayout: { ...current, ...layout } as AutoLayout } as unknown as NodeV8;
    }
    if (sizing !== undefined) {
      const next = { ...layoutSizingOf(node), ...(sizing as Partial<LayoutSizing>) };
      node = textSizingRule(withSizing(node, next), next);
    }
    if (node !== original) changed.push(node);
  }
  return commit(document, changed, custom, finish);
}

/** `removeAutoLayout` (section 5): each listed frame with auto layout loses it. */
export function removeAutoLayout(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'removeAutoLayout' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = targets(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  const changed = nodes.filter((node) => autoLayoutOf(node) !== null).map(withoutAutoLayout);
  return commit(document, changed, custom, finish);
}

/**
 * `addAutoLayout` rule 1 (section 5): every listed node is a frame; each without auto layout
 * gets the inferred one, its participants re-sorted into their slots of `children`.
 */
export function addAutoLayoutToFrames(
  document: DocumentV8,
  nodes: readonly NodeV8[],
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const changed: NodeV8[] = [];
  for (const node of nodes) {
    if (node.type !== 'frame' || autoLayoutOf(node) !== null) continue;
    const slots: number[] = [];
    const parts: NodeV8[] = [];
    node.children.forEach((id, index) => {
      const child = document.nodes[id]!;
      if (!child.visible) return;
      slots.push(index);
      parts.push(child);
    });
    const { layout, order } = inferAutoLayout(
      parts.map((child) => rotatedBounds(child)),
      node.frame.width,
      node.frame.height,
      false,
    );
    const children = [...node.children];
    order.forEach((from, i) => {
      children[slots[i]!] = parts[from]!.id;
    });
    changed.push(withSizing({ ...node, children, autoLayout: layout }, hugSizing(node)));
  }
  return commit(document, changed, custom, finish);
}

/** Whether `addAutoLayout` takes rule 1 (every listed node a frame). */
export function allFrames(document: DocumentV8, ids: readonly string[]): boolean {
  return ids.every((id) => document.nodes[id]?.type === 'frame');
}
