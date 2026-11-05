import type {
  Arrow,
  Color,
  Command,
  CommandResult,
  Constraint,
  Constraints,
  DocumentV6,
  Frame,
  NodeV6,
  TextEditState,
  TextNode,
  TextRun,
} from '@vector-studio/react';
import { numberText, parseNumber, toDegrees, toRadians, type Common } from './appearance-model.js';

// MVP M8 contract, section 7.3 (M8-R2 to M8-R5, M8-U5): the pure side of the property panel's
// transform, layer, line, constraint, text and symbol sections, internal to the package and
// unit-tested as functions (M8-Q3 (a)). Each field reads the selected nodes that have it and
// shows their common value or "mixed"; it is editable only when one node is selected, since its
// command (`setFrames` for one frame, `setNodeProps`, `setTextProps`, `setTextStyle`) takes one
// node, and one committed edit is one command (section 7). The editor validates every value;
// the panel refuses only text that cannot be one (`aria-invalid`, nothing sent).

/** The selected nodes that exist in the document, in selection order. */
export function selectedNodes(document: DocumentV6, selection: readonly string[]): NodeV6[] {
  return selection.flatMap((id) =>
    Object.hasOwn(document.nodes, id) ? [document.nodes[id] as NodeV6] : [],
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
export function transformValue(node: NodeV6, key: TransformKey): number {
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
export function transformCommand(node: NodeV6, key: TransformKey, value: number): Command {
  if (key === 'rotation') {
    return {
      type: 'setFrames',
      frames: [{ id: node.id, frame: node.frame, rotation: toRadians(value) }],
    };
  }
  const frame: Frame = { ...node.frame, [key]: value };
  return { type: 'setFrames', frames: [{ id: node.id, frame }] };
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
export const lineNodes = (nodes: readonly NodeV6[]): Extract<NodeV6, { type: 'line' }>[] =>
  nodes.filter((node): node is Extract<NodeV6, { type: 'line' }> => node.type === 'line');

/**
 * The selected nodes whose constraints take effect: children of a frame or a symbol (the
 * model's `constraints` note; a symbol has a frame's fields, M7-S1).
 */
export function constrainedNodes(document: DocumentV6, nodes: readonly NodeV6[]): NodeV6[] {
  return nodes.filter((node) => {
    const parent = Object.hasOwn(document.nodes, node.parent) ? document.nodes[node.parent] : null;
    return parent?.type === 'frame' || parent?.type === 'symbol';
  });
}

/** A name edit as one `setNodeProps` (the model checks the name). */
export function nameCommand(node: NodeV6, name: string): Command {
  return { type: 'setNodeProps', id: node.id, props: { name } };
}

/** The visibility checkbox's toggle as one `setNodeProps` of the opposite of `visible`. */
export function visibleCommand(node: NodeV6): Command {
  return { type: 'setNodeProps', id: node.id, props: { visible: !node.visible } };
}

/** A line end arrow edit as one `setNodeProps` of `startArrow` or `endArrow`. */
export function arrowCommand(line: NodeV6, key: 'startArrow' | 'endArrow', arrow: Arrow): Command {
  return { type: 'setNodeProps', id: line.id, props: { [key]: arrow } };
}

/** The node IDs a field reads, as one key: a draft resets when it changes. */
export const fieldIdentity = (nodes: readonly NodeV6[]) => JSON.stringify(nodes.map((n) => n.id));

/** One constraint edit: the node's constraints with one axis changed, one `setNodeProps`. */
export function constraintsCommand(
  node: NodeV6,
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
export const textNodes = (nodes: readonly NodeV6[]) =>
  nodes.filter((node): node is TextNode => node.type === 'text');

/** A text node's length in UTF-16 code units, the offsets `setTextStyle` takes. */
export const textLength = (node: TextNode) =>
  node.runs.reduce((length, run) => length + run.text.length, 0);

/** The text sizing modes, alignments and the model's ranges of the two text numbers. */
export const TEXT_SIZINGS: readonly TextNode['sizing'][] = Object.freeze([
  'autoWidth',
  'autoHeight',
  'fixed',
]);
export const TEXT_ALIGNS: readonly TextNode['align'][] = Object.freeze(['left', 'center', 'right']);
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
  node: TextNode,
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
export function runsIn(node: TextNode, start: number, end: number): readonly TextRun[] {
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
export function textRunStyle(texts: readonly TextNode[], textEdit: TextEditState | null): RunStyle {
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
  node: TextNode,
  range: Readonly<{ start: number; end: number }>,
  style: Readonly<Partial<Pick<TextRun, 'family' | 'size' | 'color'>>>,
): Command {
  return { type: 'setTextStyle', id: node.id, start: range.start, end: range.end, style };
}

/** The text props `setTextProps` sets. */
export type TextProps = Readonly<
  Partial<Pick<TextNode, 'sizing' | 'align' | 'letterSpacing' | 'lineHeight'>>
>;

/** One text prop edit as one `setTextProps`. */
export function textPropsCommand(node: TextNode, props: TextProps): Command {
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
  document: DocumentV6,
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

/** A refused command's code and path as the panel shows it, or '' for a success. */
export const refusalText = (result: CommandResult): string =>
  result.ok ? '' : `${result.code} ${result.path ?? ''}`.trimEnd();
