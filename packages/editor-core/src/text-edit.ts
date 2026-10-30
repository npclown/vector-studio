import type { TextLayoutRequest } from '@vector-studio/contracts';
import { validateNode, type DocumentV6, type TextNode } from '@vector-studio/model';
import { TEXT_LINE_HEIGHT } from './edits.js';
import { deepFreeze } from './freeze.js';
import { nodePlacement, type NodePlacement } from './path-edit.js';
import type { CaretModel, CaretPosition, CaretSegment } from './text-caret.js';
import { MIN_AUTHORED_TEXT_SIZE } from './text.js';
import { documentTree, isContainer, pageOf } from './tree.js';
import type {
  EditorErrorCode,
  PagePoint,
  Quad,
  TextEditOverlay,
  TextEditPending,
  TextEditState,
  TextStyle,
} from './types.js';

// Text edit mode geometry (MVP M6b contract, sections 2, 3 and 4): the edited node or pending
// node as a caret model with its node-local to page placement, the `textEditOverlay` query, the
// rotated-box test of section 4.4 and the text tool style check of M6b-S2. Points map to the
// page exactly as M3's `pathOverlay` (`nodePlacement`), so a host's caret and the select tool's
// picks agree.

/** The default text tool style (M6b-S2, M6b-Q7 (a)). */
export const DEFAULT_TEXT_STYLE: TextStyle = deepFreeze({
  family: 'Arial',
  size: 16,
  color: { r: 0, g: 0, b: 0, a: 1 },
});

/**
 * The edited text in caret terms: its caret model over the editor's cached layout, its
 * node-local box (`width` by `height`) and the placement of that box on the page.
 */
export type TextEditTarget = NodePlacement &
  Readonly<{ model: CaretModel; width: number; height: number; pending: boolean }>;

/** What the select tool reads of text edit mode (section 4.4): no command, no state. */
export interface TextEditSupport {
  /** The edited node or pending node, or null outside edit mode. */
  current(): TextEditTarget | null;
  /** Text node `id` of the active page, or null (no port, or not a text node there). */
  of(id: string): TextEditTarget | null;
}

/** The text node `id` of `page`, or undefined. */
export function editableText(document: DocumentV6, page: string, id: string): TextNode | undefined {
  const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
  if (node?.type !== 'text') return undefined;
  return pageOf(documentTree(document), id) === page ? node : undefined;
}

/** Whether `parent` is the page `page` or a container of it (section 3.3, pending exit). */
export function pendingParentHolds(document: DocumentV6, page: string, parent: string): boolean {
  if (parent === page) return true;
  const tree = documentTree(document);
  return isContainer(tree.node(parent)) && pageOf(tree, parent) === page;
}

/**
 * The empty layout request of a pending node (section 4.3): one empty run in its style, the
 * `createText` defaults (`left`, letter spacing 0, line height 1.2), wrapping at the frame
 * width for `autoHeight`.
 */
export function pendingRequest(pending: TextEditPending): TextLayoutRequest {
  const { family, size } = pending.style;
  return {
    runs: [{ text: '', family, size }],
    width: pending.sizing === 'autoWidth' ? null : pending.frame.width,
    align: 'left',
    letterSpacing: 0,
    lineHeight: TEXT_LINE_HEIGHT,
  };
}

/** A pending node's placement: its page-space frame at rotation 0. */
export function pendingPlacement(pending: TextEditPending): NodePlacement {
  const { x, y } = pending.frame;
  return {
    toPage: (l) => ({ x: x + l.x, y: y + l.y }),
    toLocal: (p) => ({ x: p.x - x, y: p.y - y }),
  };
}

/** A text node's target over `model`. */
export function nodeTarget(
  document: DocumentV6,
  node: TextNode,
  model: CaretModel,
): TextEditTarget {
  const { width, height } = node.frame;
  return { ...nodePlacement(document, node), model, width, height, pending: false };
}

/** A pending node's target over `model` (its empty layout). */
export function pendingTarget(pending: TextEditPending, model: CaretModel): TextEditTarget {
  const { width, height } = pending.frame;
  return { ...pendingPlacement(pending), model, width, height, pending: true };
}

/**
 * Whether the page point `point` is inside the target's rotated box (section 4.4), closed, the
 * box grown by `grow` page units on each side (a pending node's `HANDLE_RADIUS / zoom`).
 */
export function insideTarget(target: TextEditTarget, point: PagePoint, grow: number): boolean {
  const { x, y } = target.toLocal(point);
  return x >= -grow && x <= target.width + grow && y >= -grow && y <= target.height + grow;
}

/** The offset at the page point `point` (section 4.3, point to offset in the node's axes). */
export function caretAtPoint(target: TextEditTarget, point: PagePoint): CaretPosition {
  return target.model.pointToOffset(target.toLocal(point));
}

/**
 * The `textEditOverlay` query value (section 4.5): frozen, in page space. The caret is the
 * focus caret when the selection is collapsed; `inputRect` is the axis-aligned top-left and
 * height of the focus caret's page segment.
 */
export function textEditOverlay(target: TextEditTarget, state: TextEditState): TextEditOverlay {
  const { model, toPage } = target;
  const segment = ([a, b]: CaretSegment) => [toPage(a), toPage(b)] as const;
  const focus = segment(model.caretSegment({ offset: state.focus, affinity: state.affinity }));
  const selection = model
    .selectionRects(state.anchor, state.focus)
    .map(({ x, y, width, height }): Quad => [
      toPage({ x, y }),
      toPage({ x: x + width, y }),
      toPage({ x: x + width, y: y + height }),
      toPage({ x, y: y + height }),
    ]);
  const { composition } = state;
  const underline =
    composition === null
      ? []
      : model.compositionSegments(composition.start, composition.end).map(segment);
  const [a, b] = focus;
  return deepFreeze({
    id: state.id,
    caret: state.anchor === state.focus ? focus : null,
    selection,
    composition: underline,
    inputRect: {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      height: Math.abs(b.y - a.y),
    },
  });
}

type StyleFailure = Readonly<{ ok: false; code: EditorErrorCode; path: string }>;

/**
 * The check of `setTextToolStyle` and `EditorOptions.textStyle` (M6b-S2): an object with
 * exactly `family`, `size` and `color` (`editor.invalid-command` at the field), the model's run
 * rules (M6a-S3, reported under `/style`), then the authored size floor (M6a-Q19). Returns a
 * frozen plain copy.
 */
export function checkTextStyle(value: unknown): TextStyle | StyleFailure {
  const invalid = (path: string): StyleFailure => ({
    ok: false,
    code: 'editor.invalid-command',
    path,
  });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('/style');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'family' && key !== 'size' && key !== 'color') return invalid(`/style/${key}`);
  }
  for (const key of ['family', 'size', 'color']) {
    if (!Object.hasOwn(record, key)) return invalid(`/style/${key}`);
  }
  const run = { text: '', family: record.family, size: record.size, color: record.color };
  // A one-run probe node, so the model's own run rules (M6a-S3) judge the style.
  const result = validateNode({
    id: 'style',
    name: 'style',
    parent: 'page',
    frame: { x: 0, y: 0, width: 0, height: 0 },
    rotation: 0,
    constraints: { horizontal: 'start', vertical: 'start' },
    opacity: 1,
    visible: true,
    type: 'text',
    runs: [run],
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: TEXT_LINE_HEIGHT,
  });
  if (!result.ok) {
    const prefix = '/runs/0';
    const path = result.path.startsWith(prefix) ? result.path.slice(prefix.length) : '';
    return { ok: false, code: result.code, path: `/style${path}` };
  }
  const checked = (result.node as TextNode).runs[0]!;
  if (checked.size < MIN_AUTHORED_TEXT_SIZE) return invalid('/style/size');
  const { r, g, b, a } = checked.color;
  return deepFreeze({ family: checked.family, size: checked.size, color: { r, g, b, a } });
}
