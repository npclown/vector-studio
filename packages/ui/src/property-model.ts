import type {
  Arrow,
  Color,
  Command,
  CommandResult,
  Constraint,
  Constraints,
  DocumentV8,
  Frame,
  NodeV8,
  SelectionHandles,
  TextEditState,
  TextNodeV8,
  TextRun,
} from '@vector-studio/react';
import { booleanNotice } from './boolean-model.js';
import { effectNotice } from './effects-model.js';
import {
  numberText,
  parseHex,
  parseNumber,
  toDegrees,
  toRadians,
  type Common,
} from './appearance-model.js';

// MVP M8 contract, section 7.3 (M8-R2 to M8-R5, M8-U5): the pure side of the property panel's
// transform, layer, line, constraint, text and symbol sections, internal to the package and
// unit-tested as functions (M8-Q3 (a)). Each field reads the selected nodes that have it and
// shows their common value or "mixed"; it is editable only when one node is selected, since its
// command (`setFrames` for one frame, `setNodeProps`, `setTextProps`, `setTextStyle`) takes one
// node, and one committed edit is one command (section 7). The editor validates every value;
// the panel refuses only text that cannot be one (`aria-invalid`, nothing sent).

/** The selected nodes that exist in the document, in selection order. */
export function selectedNodes(document: DocumentV8, selection: readonly string[]): NodeV8[] {
  return selection.flatMap((id) =>
    Object.hasOwn(document.nodes, id) ? [document.nodes[id] as NodeV8] : [],
  );
}

/** Values compare as JSON, the model's normalized form, as the appearance panel's do. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The common value of `read` over `values`: none for an empty list, one value, or mixed. */
export function commonOf<N, T>(values: readonly N[], read: (value: N) => T): Common<T> {
  let found: { value: T } | null = null;
  for (const value of values) {
    const next = read(value);
    if (found === null) found = { value: next };
    else if (!same(found.value, next)) return { state: 'mixed' };
  }
  return found === null ? { state: 'none' } : { state: 'one', value: found.value };
}

/** A common number as a field shows it, or null when mixed or absent. */
export const commonText = (value: Common<number>): string | null =>
  value.state === 'one' ? numberText(value.value) : null;

// M8-R2 transform.

/** A transform field: the parent-local frame's four values, or the rotation in degrees. */
export type TransformKey = 'x' | 'y' | 'width' | 'height' | 'rotation';

/** The transform fields in panel order with their labels (X, Y, W, H, rotation). */
export const TRANSFORM_FIELDS: readonly Readonly<{ key: TransformKey; label: string }>[] =
  Object.freeze([
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
    { key: 'width', label: 'W' },
    { key: 'height', label: 'H' },
    { key: 'rotation', label: 'Rotation' },
  ]);

/** A node's value of a transform field: the stored frame value, or the rotation in degrees. */
export function transformValue(node: NodeV8, key: TransformKey): number {
  return key === 'rotation' ? toDegrees(node.rotation) : node.frame[key];
}

/**
 * A transform field's text as a value: a finite number, at least 0 for W and H (the model's
 * frame rule), or null.
 */
export function parseTransform(key: TransformKey, text: string): number | null {
  return parseNumber(text, key === 'width' || key === 'height' ? 0 : -Infinity);
}

/**
 * M8-Q8 (a): one transform edit as one `setFrames` of the node's stored parent-local frame with
 * one value changed, or of its rotation (degrees in, radians written; the model normalizes it).
 */
export function transformCommand(node: NodeV8, key: TransformKey, value: number): Command {
  if (key === 'rotation') {
    return {
      type: 'setFrames',
      frames: [{ id: node.id, frame: node.frame, rotation: toRadians(value) }],
    };
  }
  const frame: Frame = { ...node.frame, [key]: value };
  return { type: 'setFrames', frames: [{ id: node.id, frame }] };
}

// V-25 slice 9: X, Y, W and H of the selection box. The fields show the box the select tool's
// handles sit on (the `handles` query), so they match the box on the canvas: for one node its
// content box (V-26: a path's curve, not its Bézier handles), X and Y being the box's top-left
// corner in the parent's space (turned with the node's rotation, as Figma shows a rotated
// node), W and H in its own axes; for several nodes the page-aligned box around them all. Each
// committed edit is one command, so one undo step.

/** The box the transform fields show and edit. */
export type TransformTarget =
  | Readonly<{ kind: 'one'; node: NodeV8; content: Frame; box: Frame }>
  | Readonly<{ kind: 'many'; nodes: readonly NodeV8[]; box: Frame; scalable: boolean }>;

/** The point at `(lx, ly)` of a node's own axes in its parent's space (`localTransform`). */
function localPoint(frame: Frame, rotation: number, lx: number, ly: number) {
  if (rotation === 0) return { x: frame.x + lx, y: frame.y + ly };
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = lx - frame.width / 2;
  const dy = ly - frame.height / 2;
  return {
    x: frame.x + frame.width / 2 + dx * cos - dy * sin,
    y: frame.y + frame.height / 2 + dx * sin + dy * cos,
  };
}

/**
 * The transform fields' box for the selected `nodes`, from the `handles` query (null in path and
 * text edit mode, where one node's whole frame stands in), or null when nothing is selected.
 * Several nodes scale through W and H only when each is a page-root node with rotation 0 (the
 * select tool's P5 resize, one `setFrames`); other multi-selections show W and H read-only.
 */
export function transformTarget(
  nodes: readonly NodeV8[],
  handles: SelectionHandles | null,
  page: string,
): TransformTarget | null {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) {
    const node = nodes[0]!;
    const content = handles?.content ?? {
      x: 0,
      y: 0,
      width: node.frame.width,
      height: node.frame.height,
    };
    const corner = localPoint(node.frame, node.rotation, content.x, content.y);
    return {
      kind: 'one',
      node,
      content,
      box: { x: corner.x, y: corner.y, width: content.width, height: content.height },
    };
  }
  if (handles === null) return null;
  const [tl, tr, , bl] = handles.corners;
  return {
    kind: 'many',
    nodes,
    box: { x: tl.x, y: tl.y, width: tr.x - tl.x, height: bl.y - tl.y },
    scalable: nodes.every((node) => node.parent === page && node.rotation === 0),
  };
}

/** A box value as a field shows it: at most two decimals, as Figma shows them. */
export const boxText = (value: number): string => {
  const rounded = Number(value.toFixed(2));
  return String(rounded === 0 ? 0 : rounded);
};

/** A transform field's shown text: the box value, or the common rotation (null when mixed). */
export function targetText(target: TransformTarget, key: TransformKey): string | null {
  if (key !== 'rotation') return boxText(target.box[key]);
  const nodes = target.kind === 'one' ? [target.node] : target.nodes;
  const rotation = commonOf(nodes, (node) => toDegrees(node.rotation));
  return rotation.state === 'one' ? boxText(rotation.value) : null;
}

/**
 * Whether a transform field takes input for the target: W and H of several nodes only when they
 * scale (unrotated page-root nodes) and their box has a size on that axis.
 */
export const targetEditable = (target: TransformTarget, key: TransformKey): boolean =>
  target.kind === 'one' ||
  key === 'x' ||
  key === 'y' ||
  key === 'rotation' ||
  (target.scalable && target.box[key] !== 0);

/**
 * One transform edit of the target as one command, or null when it cannot apply. X and Y move
 * the box by the difference to its shown corner: one node by its stored frame (`setFrames`),
 * several by a page vector (`nudgeNodes`). W and H scale the box about its left or top edge: one
 * node in its own axes (the edge stays put in the parent's space, as the select tool's resize
 * with the opposite handle), several page-root nodes each about the box's edge. A box of size 0
 * on that axis only takes a size when the node's frame is that size too. The rotation sets each
 * node's rotation in degrees (`setFrames`, about its frame's centre as M8-R2).
 */
export function targetCommand(
  target: TransformTarget,
  key: TransformKey,
  value: number,
): Command | null {
  if (key === 'rotation') {
    const nodes = target.kind === 'one' ? [target.node] : target.nodes;
    return {
      type: 'setFrames',
      frames: nodes.map((node) => ({ id: node.id, frame: node.frame, rotation: toRadians(value) })),
    };
  }
  const { box } = target;
  if (key === 'x' || key === 'y') {
    const d = value - box[key];
    if (target.kind === 'many') {
      return {
        type: 'nudgeNodes',
        ids: target.nodes.map((node) => node.id),
        dx: key === 'x' ? d : 0,
        dy: key === 'y' ? d : 0,
      };
    }
    const { node } = target;
    return {
      type: 'setFrames',
      frames: [{ id: node.id, frame: { ...node.frame, [key]: node.frame[key] + d } }],
    };
  }
  const old = box[key];
  if (target.kind === 'many') {
    if (!target.scalable || old === 0) return null;
    const s = value / old;
    const origin = key === 'width' ? box.x : box.y;
    const at = key === 'width' ? 'x' : 'y';
    return {
      type: 'setFrames',
      frames: target.nodes.map((node) => ({
        id: node.id,
        frame: {
          ...node.frame,
          [at]: origin + (node.frame[at] - origin) * s,
          [key]: node.frame[key] * s,
        },
      })),
    };
  }
  const { node, content } = target;
  const { frame, rotation } = node;
  if (old === 0) {
    if (frame[key] !== 0) return null;
    return { type: 'setFrames', frames: [{ id: node.id, frame: { ...frame, [key]: value } }] };
  }
  const s = value / old;
  const sx = key === 'width' ? s : 1;
  const sy = key === 'height' ? s : 1;
  const width = frame.width * sx;
  const height = frame.height * sy;
  // The content box's top-left corner stays in place in the parent's space.
  const anchor = localPoint(frame, rotation, content.x, content.y);
  const moved = localPoint({ ...frame, width, height }, rotation, content.x * sx, content.y * sy);
  return {
    type: 'setFrames',
    frames: [
      {
        id: node.id,
        frame: { x: frame.x + anchor.x - moved.x, y: frame.y + anchor.y - moved.y, width, height },
      },
    ],
  };
}

// M8-R3 layer, line and constraints.

/** The line end arrows, in the model's order. */
export const ARROWS: readonly Arrow[] = Object.freeze(['none', 'line', 'triangle']);
/** The constraint values, in the model's order. */
export const CONSTRAINTS: readonly Constraint[] = Object.freeze([
  'start',
  'end',
  'startEnd',
  'center',
  'scale',
]);

/** The selected lines. */
export const lineNodes = (nodes: readonly NodeV8[]): Extract<NodeV8, { type: 'line' }>[] =>
  nodes.filter((node): node is Extract<NodeV8, { type: 'line' }> => node.type === 'line');

/**
 * The selected nodes whose constraints take effect: children of a frame or a symbol (the
 * model's `constraints` note; a symbol has a frame's fields, M7-S1).
 */
export function constrainedNodes(document: DocumentV8, nodes: readonly NodeV8[]): NodeV8[] {
  return nodes.filter((node) => {
    const parent = Object.hasOwn(document.nodes, node.parent) ? document.nodes[node.parent] : null;
    return parent?.type === 'frame' || parent?.type === 'symbol';
  });
}

/** A name edit as one `setNodeProps` (the model checks the name). */
export function nameCommand(node: NodeV8, name: string): Command {
  return { type: 'setNodeProps', id: node.id, props: { name } };
}

/** The visibility checkbox's toggle as one `setNodeProps` of the opposite of `visible`. */
export function visibleCommand(node: NodeV8): Command {
  return { type: 'setNodeProps', id: node.id, props: { visible: !node.visible } };
}

/** A line end arrow edit as one `setNodeProps` of `startArrow` or `endArrow`. */
export function arrowCommand(line: NodeV8, key: 'startArrow' | 'endArrow', arrow: Arrow): Command {
  return { type: 'setNodeProps', id: line.id, props: { [key]: arrow } };
}

/** The node IDs a field reads, as one key: a draft resets when it changes. */
export const fieldIdentity = (nodes: readonly NodeV8[]) => JSON.stringify(nodes.map((n) => n.id));

/** One constraint edit: the node's constraints with one axis changed, one `setNodeProps`. */
export function constraintsCommand(
  node: NodeV8,
  axis: keyof Constraints,
  value: Constraint,
): Command {
  return {
    type: 'setNodeProps',
    id: node.id,
    props: { constraints: { ...node.constraints, [axis]: value } },
  };
}

// M8-R4 text.

/** The selected text nodes. */
export const textNodes = (nodes: readonly NodeV8[]) =>
  nodes.filter((node): node is TextNodeV8 => node.type === 'text');

/** A text node's length in UTF-16 code units, the offsets `setTextStyle` takes. */
export const textLength = (node: TextNodeV8) =>
  node.runs.reduce((length, run) => length + run.text.length, 0);

/** The text sizing modes, alignments and the model's ranges of the two text numbers. */
export const TEXT_SIZINGS: readonly TextNodeV8['sizing'][] = Object.freeze([
  'autoWidth',
  'autoHeight',
  'fixed',
]);
export const TEXT_ALIGNS: readonly TextNodeV8['align'][] = Object.freeze([
  'left',
  'center',
  'right',
]);
/** `letterSpacing` in em, `[-1, 10]`, and `lineHeight` as a multiple, `[0.1, 10]` (M6a-S1). */
export const LETTER_SPACING_RANGE = Object.freeze([-1, 10] as const);
export const LINE_HEIGHT_RANGE = Object.freeze([0.1, 10] as const);
/** A run's size, in `(0, 4096]` (M6a-S1). */
export const MAX_FONT_SIZE = 4096;

/** A font size field's text as a size in `(0, 4096]`, or null. */
export function parseFontSize(text: string): number | null {
  const size = parseNumber(text, 0, MAX_FONT_SIZE);
  return size === null || size === 0 ? null : size;
}

/** A font family field's text, trimmed, or null when empty (the model checks the name). */
export function parseFamily(text: string): string | null {
  const family = text.trim();
  return family === '' ? null : family;
}

/**
 * The range the run fields edit (M8-R4, M8-Q9 (a)): the text edit selection of this node when
 * it is not collapsed (start before end), null for a collapsed caret (the run fields are
 * disabled), else the node's whole text `[0, length)`.
 */
export function textRange(
  node: TextNodeV8,
  textEdit: TextEditState | null,
): Readonly<{ start: number; end: number }> | null {
  if (textEdit !== null && textEdit.id === node.id) {
    if (textEdit.anchor === textEdit.focus) return null;
    return {
      start: Math.min(textEdit.anchor, textEdit.focus),
      end: Math.max(textEdit.anchor, textEdit.focus),
    };
  }
  return { start: 0, end: textLength(node) };
}

/**
 * The runs `[start, end)` covers: each run overlapping it, or for an empty range the run holding
 * `start` (an empty node's one run).
 */
export function runsIn(node: TextNodeV8, start: number, end: number): readonly TextRun[] {
  const found: TextRun[] = [];
  let at = 0;
  for (const run of node.runs) {
    const next = at + run.text.length;
    const hit = start === end ? at <= start && start <= next : at < end && next > start;
    if (hit) found.push(run);
    if (hit && start === end) break;
    at = next;
  }
  return found;
}

/** The run style fields: family, size and colour. */
export type RunStyle = Readonly<{
  family: Common<string>;
  size: Common<number>;
  color: Common<Color>;
}>;

/**
 * The run fields' values over the selected text nodes: the common family, size and colour of
 * the runs each node's `textRange` covers, or of the caret's run for a collapsed caret, where
 * the fields are disabled but still show it (M8-Q9 (a)).
 */
export function textRunStyle(
  texts: readonly TextNodeV8[],
  textEdit: TextEditState | null,
): RunStyle {
  const runs = texts.flatMap((node) => {
    const range = textRange(node, textEdit) ?? { start: textEdit!.focus, end: textEdit!.focus };
    return runsIn(node, range.start, range.end);
  });
  return {
    family: commonOf(runs, (run) => run.family),
    size: commonOf(runs, (run) => run.size),
    color: commonOf(runs, (run) => run.color),
  };
}

/** One run style edit over `range` as one `setTextStyle`. */
export function textStyleCommand(
  node: TextNodeV8,
  range: Readonly<{ start: number; end: number }>,
  style: Readonly<Partial<Pick<TextRun, 'family' | 'size' | 'color'>>>,
): Command {
  return { type: 'setTextStyle', id: node.id, start: range.start, end: range.end, style };
}

/** The text props `setTextProps` sets. */
export type TextProps = Readonly<
  Partial<Pick<TextNodeV8, 'sizing' | 'align' | 'letterSpacing' | 'lineHeight'>>
>;

/** One text prop edit as one `setTextProps`. */
export function textPropsCommand(node: TextNodeV8, props: TextProps): Command {
  return { type: 'setTextProps', id: node.id, ...props };
}

// M8-R5 symbols.

/** A property panel button: its label (its accessible name) and its one command. */
export type PropertyAction = Readonly<{
  label: string;
  command: Command;
  /** Select the command's result IDs after it succeeds (a new instance). */
  selectResult: boolean;
}>;

/** A "Reset text" button for one overridden text node of an instance. */
export type ResetTextAction = PropertyAction &
  Readonly<{
    /** The source text node's ID. */
    node: string;
    /** The source text node's name, or its ID when it is missing. */
    name: string;
  }>;

/** The symbol section of one selected node, or null for any other selection. */
export type SymbolSection =
  | Readonly<{ kind: 'source'; create: PropertyAction }>
  | Readonly<{ kind: 'instance'; detach: PropertyAction; resets: readonly ResetTextAction[] }>;

/**
 * M8-R5: for one selected source, "Create instance" (`createInstance`, the new instance then
 * selected, as the toolbar's `instance` does); for one selected instance, "Detach instance"
 * (`detachInstances` of it) and one "Reset text" (`clearInstanceText` with `node`) per text
 * override, in the override keys' order. Null for no, several or other selected nodes.
 */
export function symbolSection(
  document: DocumentV8,
  selection: readonly string[],
): SymbolSection | null {
  if (selection.length !== 1) return null;
  const node = selectedNodes(document, selection)[0];
  if (node === undefined) return null;
  if (node.type === 'symbol') {
    return {
      kind: 'source',
      create: {
        label: 'Create instance',
        command: { type: 'createInstance', symbol: node.id },
        selectResult: true,
      },
    };
  }
  if (node.type !== 'instance') return null;
  return {
    kind: 'instance',
    detach: {
      label: 'Detach instance',
      command: { type: 'detachInstances', ids: [node.id] },
      selectResult: false,
    },
    resets: Object.keys(node.textOverrides).map((source) => ({
      label: 'Reset text',
      command: { type: 'clearInstanceText', id: node.id, node: source },
      selectResult: false,
      node: source,
      name: Object.hasOwn(document.nodes, source) ? document.nodes[source]!.name : source,
    })),
  };
}

/**
 * Runs a property action's command, then on success selects its result IDs when it asks to (a
 * session command, so the document edit stays one undo step); returns the command's result.
 */
export function runPropertyAction(
  execute: (command: Command) => CommandResult,
  action: PropertyAction,
): CommandResult {
  const result = execute(action.command);
  if (result.ok && action.selectResult) execute({ type: 'setSelection', ids: result.ids });
  return result;
}

/**
 * A refused command's code and path as the panel shows it, or '' for a success; a refused boolean
 * shows its notice (E41-U3b), and so does a refused effect add past the limits (E41-U7).
 */
export const refusalText = (result: CommandResult): string =>
  result.ok
    ? ''
    : (booleanNotice(result) ??
      effectNotice(result) ??
      `${result.code} ${result.path ?? ''}`.trimEnd());

/**
 * V-25 slice 5: the run colour a hex field, picker or swatch writes: `hex` with the shown run
 * colour's alpha, opaque when it is mixed or none; null when `hex` is not `#rrggbb`.
 */
export function runColor(hex: string, shown: Common<Color>): Color | null {
  return parseHex(hex, shown.state === 'one' ? shown.value.a : 1);
}

/**
 * V-25 slice 5 (review r1): the `setTextStyle` a colour picker commits to the run range it was
 * opened on, so a later focus or caret move (closing Chrome's popup by a click outside it blurs
 * the picker and can end edit mode before the queued `change`) does not move the pick elsewhere.
 */
export function pickedColorCommand(
  target: Readonly<{ id: string; start: number; end: number; shown: Common<Color> }>,
  hex: string,
): Command | null {
  const color = runColor(hex, target.shown);
  if (color === null) return null;
  return {
    type: 'setTextStyle',
    id: target.id,
    start: target.start,
    end: target.end,
    style: { color },
  };
}
