import {
  MAX_TREE_DEPTH,
  normalizeRotation,
  validateNode,
  type DocumentV6,
  type Frame,
  type NodeV6,
  type PageV2,
  type Stroke,
  type SymbolNodeV6,
  type TextNode,
} from '@vector-studio/model';
import {
  alignNodes,
  distributeNodes,
  duplicateNodes,
  nudgeNodes,
  reorderNodes,
} from './arrange.js';
import { paste } from './clipboard.js';
import { Draft, fail, type Failure } from './draft.js';
import { ExpansionCache, expansionFailure } from './expansion.js';
import {
  freshId,
  inserted,
  isPoint,
  nodeOf,
  PENDING_ID,
  placeholderIds,
  success,
  uniqueIds,
  type CustomRules,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { deepFreeze } from './freeze.js';
import {
  apply,
  fitPoints,
  IDENTITY,
  invertRigid,
  localTransform,
  relocate,
  rotate,
  rotatedBounds,
} from './geometry.js';
import {
  closePathSubpath,
  insertPathAnchor,
  movePathAnchors,
  openPathSubpath,
  removePathAnchors,
  setPathHandle,
} from './paths.js';
import { mapNodeInPageSpace, resizeContainer, type ScaleMap } from './resize.js';
import {
  frameRule,
  isAuto,
  MIN_AUTHORED_TEXT_SIZE,
  refitFrame,
  type TextLayouter,
} from './text.js';
import { refitText, setText, setTextProps, setTextStyle } from './text-edits.js';
import { boundsOf } from './hit-test.js';
import { clearInstanceText, setInstanceText } from './instance-text.js';
import { detachInstances, orphanedInstances, withDetach } from './symbols.js';
import { visualBounds } from './visual-bounds.js';
import { handleBoxOf, handleCentre } from './handles.js';
import {
  ancestors,
  childIsolationCount,
  childrenOf,
  clipDepth,
  clipsChildren,
  documentTree,
  isAncestor,
  isContainer,
  isGroup,
  isolationBreaks,
  nodePath,
  pageOf,
  spaceOf,
  subtree,
  instanceClipBreaks,
  sourceClipLevels,
  sourceHeight,
  treeDepth,
  treeDepthViolation,
  type TreeView,
} from './tree.js';
import type { DocumentCommand, PagePoint } from './types.js';

// Pure document edits: each takes a valid document and returns a new valid document, or a
// failure that leaves nothing changed. Nodes are validated with the model's own field rules.
// MVP M1 contract, sections 3 and 4: pages, creation with placement, placement edits with the
// resize rules and group refit, grouping and reparenting, and the clip and tree depth bounds.
// Failures follow the precedence of section 4.3.1.

export { deepFreeze };
export type { CustomRules, EditContext, EditResult };

/** Defaults for creation when the command gives no style (P5 plan section 14, M1 section 4.1). */
export const DEFAULT_RECTANGLE_FILL = deepFreeze({ r: 0.8, g: 0.8, b: 0.8, a: 1 } as const);
export const DEFAULT_PATH_STROKE = deepFreeze({
  color: { r: 0, g: 0, b: 0, a: 1 },
  width: 1,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  dash: null,
} as const);
/**
 * The stroke a rectangle, ellipse, frame or symbol gets when one is added (MVP M4 contract,
 * section 4.1, M4-Q4 (a)): a `round` join, which the analytic primitive draws.
 */
export const DEFAULT_SHAPE_STROKE = deepFreeze({
  color: { r: 0, g: 0, b: 0, a: 1 },
  width: 1,
  cap: 'butt',
  join: 'round',
  miterLimit: 4,
  dash: null,
} as const);
export const DEFAULT_FRAME_FILL = deepFreeze({ r: 1, g: 1, b: 1, a: 1 } as const);
const START = deepFreeze({ horizontal: 'start', vertical: 'start' } as const);
/** `createText` defaults (M6a contract, section 6.1, M6a-Q16). */
const TEXT_LINE_HEIGHT = 1.2;

const NO_CUSTOM: CustomRules = {
  check: (node) =>
    node.type === 'custom' ? { code: 'document.unknown-custom-type', path: '/customType' } : null,
  defaults: () => ({ code: 'document.unknown-custom-type', path: '/customType' }),
};

/** Clip levels a frame or mask group, and any node, may sit at (section 4.3). */
const MAX_CLIP_CONTAINER_DEPTH = 31;
const MAX_CLIP_DEPTH = 32;

/** The props each node type has (section 4.2); any other prop is `editor.invalid-command`. */
const COMMON_PROPS = ['name', 'opacity', 'visible', 'constraints'];
const PROPS: Readonly<Record<NodeV6['type'], readonly string[]>> = {
  rectangle: [...COMMON_PROPS, 'fill', 'stroke', 'cornerRadii'],
  ellipse: [...COMMON_PROPS, 'fill', 'stroke'],
  line: [...COMMON_PROPS, 'stroke', 'startArrow', 'endArrow'],
  path: [...COMMON_PROPS, 'fill', 'stroke'],
  custom: [...COMMON_PROPS, 'fill', 'stroke', 'data'],
  group: COMMON_PROPS,
  maskGroup: COMMON_PROPS,
  frame: [...COMMON_PROPS, 'fill', 'stroke'],
  // M7 contract: a symbol has a frame's props (section 1.2), an instance only the common ones
  // (section 5.1; its opacity any in `[0, 1]` since M4-U3, M4 contract, section 5).
  symbol: [...COMMON_PROPS, 'fill', 'stroke'],
  instance: COMMON_PROPS,
  // M6a contract, section 6.1: a text node takes the common props only; its own props are
  // `setTextProps`'s.
  text: COMMON_PROPS,
};

function isIndex(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/** Clip levels a new child of `owner` sits at. */
function childClipDepth(tree: TreeView, owner: string): number {
  const node = tree.node(owner);
  if (!isContainer(node)) return 0;
  return clipDepth(tree, owner) + (clipsChildren(node) ? 1 : 0);
}

/**
 * Restores the descendants of container `id` to their state in `base` when its subtree there has
 * the same members, and returns the container's frame in `base`; null leaves the draft as is.
 */
function restoreSubtree(draft: Draft, base: DocumentV6, id: string): Frame | null {
  const baseTree = documentTree(base);
  const origin = baseTree.node(id);
  if (origin === undefined) return null;
  const members = subtree(baseTree, id);
  const current = subtree(draft, id);
  if (members.length !== current.length || members.some((member, i) => member !== current[i])) {
    return null;
  }
  for (const member of members.slice(1)) {
    const node = baseTree.node(member)!;
    if (draft.node(member) !== node) draft.setChecked(node, true);
  }
  return origin.frame;
}

export function applyEdit(
  document: DocumentV6,
  command: DocumentCommand,
  context: EditContext,
): EditResult {
  const custom = context.custom ?? NO_CUSTOM;
  const refit = context.refit ?? true;
  const expansions = context.expansions ?? new ExpansionCache((node) => custom.check(node));
  const finish = (draft: Draft) =>
    draft.finish((node) => custom.check(node), { refit, expansions, layout: context.layout });
  switch (command.type) {
    case 'createRectangle':
    case 'createEllipse':
    case 'createFrame':
    case 'createLine':
    case 'createPath':
    case 'createCustomNode':
    case 'createText':
      return create(document, command, context, custom, finish);
    case 'setText':
      return setText(document, command, context, finish);
    case 'setTextStyle':
      return setTextStyle(document, command, context, finish);
    case 'setTextProps':
      return setTextProps(document, command, context, finish);
    case 'refitText':
      return refitText(document, command, context, finish);
    case 'setFrames': {
      const frames: unknown = command.frames;
      if (!Array.isArray(frames)) return fail('editor.invalid-command', '/frames');
      const entries = frames as readonly { id: string; frame: unknown; rotation?: unknown }[];
      const frameIds = uniqueIds(entries.map((entry) => (entry as { id?: unknown } | null)?.id));
      if (frameIds === null || frameIds.length === 0) {
        return fail('editor.invalid-command', '/frames');
      }
      if (frameIds.some((id) => nodeOf(document, id) === undefined)) {
        return fail('editor.unknown-node');
      }
      const tree = documentTree(document);
      const named = new Set(frameIds);
      if (frameIds.some((id) => ancestors(tree, id).some((node) => named.has(node.id)))) {
        // A container and its descendant in one call (section 4.2).
        return fail('editor.invalid-command', '/frames');
      }
      const next: NodeV6[] = [];
      const refits = new Set<string>();
      for (const entry of entries) {
        const node = document.nodes[entry.id]!;
        const rotation = entry.rotation === undefined ? node.rotation : entry.rotation;
        const result = validateNode({ ...node, frame: entry.frame, rotation });
        if (!result.ok) return fail(result.code, nodePath(entry.id, result.path));
        const rejected = custom.check(deepFreeze(result.node));
        if (rejected !== null) return fail(rejected.code, nodePath(entry.id, rejected.path));
        if (result.node.type === 'text') {
          // The `setFrames` row of M6a section 6.3, against the pre-gesture node during a
          // gesture, so updates do not compound.
          const base = context.resizeBase;
          const origin =
            base !== undefined && Object.hasOwn(base.nodes, entry.id) ? base.nodes[entry.id] : node;
          const before = (origin?.type === 'text' ? origin : node) as TextNode;
          const rule = frameRule(before, result.node.frame);
          if (rule.refit) refits.add(entry.id);
          next.push({ ...result.node, sizing: rule.sizing });
          continue;
        }
        next.push(result.node);
      }
      const draft = new Draft(document);
      for (const node of next) {
        let before = draft.node(node.id)!.frame;
        draft.setChecked(node, true);
        if (refits.has(node.id)) draft.markTextRefit(node.id);
        if (!isContainer(node)) continue;
        const base = context.resizeBase;
        if (base !== undefined) {
          const restored = restoreSubtree(draft, base, node.id);
          if (restored !== null) before = restored;
        }
        // A container's new size applies the resize rules to its descendants (section 4.4).
        resizeContainer(draft, node.id, before);
      }
      return success(finish(draft), draft, []);
    }
    case 'setNodeProps': {
      const node = nodeOf(document, command.id);
      if (node === undefined) return fail('editor.unknown-node');
      const props = command.props as Record<string, unknown> | null;
      if (typeof props !== 'object' || props === null || Object.keys(props).length === 0) {
        return fail('editor.invalid-command', '/props');
      }
      for (const key of Object.keys(props)) {
        if (!PROPS[node.type].includes(key)) return fail('editor.invalid-command', `/props/${key}`);
      }
      const result = validateNode({ ...node, ...props });
      if (!result.ok) return fail(result.code, nodePath(node.id, result.path));
      const rejected = custom.check(deepFreeze(result.node));
      if (rejected !== null) return fail(rejected.code, nodePath(node.id, rejected.path));
      const draft = new Draft(document);
      draft.setChecked(result.node, true);
      return success(finish(draft), draft, []);
    }
    case 'setStyle':
      return setStyle(document, command, context, custom, finish);
    case 'deleteNodes': {
      const ids = uniqueIds(command.ids);
      if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
      if (ids.some((id) => nodeOf(document, id) === undefined)) return fail('editor.unknown-node');
      const tree = documentTree(document);
      const listed = new Set(ids);
      // A listed descendant of a listed node goes with its ancestor.
      const roots = ids.filter((id) => !ancestors(tree, id).some((node) => listed.has(node.id)));
      const removed = new Set(roots.flatMap((id) => subtree(tree, id)));
      // The source deletion rule (M7 contract, section 5.4): every remaining instance of a
      // removed source is detached in the same transaction.
      return withDetach(
        document,
        orphanedInstances(document, removed),
        context.ids,
        expansions,
        (draft) => {
          for (const id of roots) {
            const owner = document.nodes[id]!.parent;
            draft.setChildren(
              owner,
              childrenOf(draft, owner).filter((child) => child !== id),
            );
            for (const member of subtree(tree, id)) draft.remove(member);
          }
        },
        (draft) => success(finish(draft), draft, []),
      );
    }
    case 'groupNodes':
      return group(document, command, context, finish);
    case 'createSymbol':
      return createSymbol(document, command, context, finish);
    case 'createInstance':
      return create(document, command, context, custom, finish);
    case 'detachInstances':
      return detachInstances(document, command, context, expansions, finish);
    case 'setInstanceText':
      return setInstanceText(document, command, context, finish);
    case 'clearInstanceText':
      return clearInstanceText(document, command, context, finish);
    case 'ungroupNodes': {
      if (typeof command.id !== 'string') return fail('editor.invalid-command', '/id');
      const node = nodeOf(document, command.id);
      if (node === undefined) return fail('editor.unknown-node');
      if (!isGroup(node)) return fail('editor.not-a-group');
      const draft = new Draft(document);
      const owner = node.parent;
      const siblings = childrenOf(draft, owner);
      const at = siblings.indexOf(node.id);
      // Each child keeps its page placement: the container's transform is composed into it.
      // M4-Q17 (a) (MVP M4 contract, section 12): the group's opacity is multiplied into each
      // child's (binary64 product), so pixels stay the same where the children do not overlap.
      const space = localTransform(node.frame, node.rotation);
      for (const id of node.children) {
        const child = document.nodes[id]!;
        const moved = relocate(child.frame, child.rotation, space, node.rotation, IDENTITY, 0);
        const opacity = node.opacity === 1 ? child.opacity : child.opacity * node.opacity;
        draft.set({ ...child, parent: owner, ...moved, opacity });
      }
      draft.setChildren(owner, [
        ...siblings.slice(0, at),
        ...node.children,
        ...siblings.slice(at + 1),
      ]);
      draft.remove(node.id);
      return success(finish(draft), draft, []);
    }
    case 'moveNodes':
      return move(document, command, finish);
    case 'rotateNodes':
      return rotateNodes(document, command, context, finish);
    case 'alignNodes':
      return alignNodes(document, command, context, finish);
    case 'distributeNodes':
      return distributeNodes(document, command, context, finish);
    case 'reorderNodes':
      return reorderNodes(document, command, context, finish);
    case 'nudgeNodes':
      return nudgeNodes(document, command, context, finish);
    case 'duplicateNodes':
      return duplicateNodes(document, command, context, finish);
    case 'paste':
      return paste(document, command, context, custom, finish);
    case 'movePathAnchors':
      return movePathAnchors(document, command, context, finish);
    case 'setPathHandle':
      return setPathHandle(document, command, context, finish);
    case 'insertPathAnchor':
      return insertPathAnchor(document, command, context, finish);
    case 'removePathAnchors':
      return removePathAnchors(document, command, context, finish);
    case 'closePathSubpath':
      return closePathSubpath(document, command, context, finish);
    case 'openPathSubpath':
      return openPathSubpath(document, command, context, finish);
    case 'addPage': {
      if (command.name !== undefined && typeof command.name !== 'string') {
        return fail('editor.invalid-command', '/name');
      }
      const index = command.index ?? document.pages.length;
      if (!isIndex(index, document.pages.length)) return fail('editor.invalid-index');
      // The ID is drawn once every other check passed, so a failed command draws none.
      const id = freshId(document, context.ids);
      if (id === null) return fail('editor.duplicate-id');
      const page: PageV2 = {
        id,
        name: command.name ?? `Page ${document.pages.length + 1}`,
        children: [],
      };
      const draft = new Draft(document);
      draft.setPages(inserted(document.pages, index, [page]));
      return success(finish(draft), draft, [id]);
    }
    case 'removePage': {
      if (typeof command.id !== 'string') return fail('editor.invalid-command', '/id');
      const page = document.pages.find((entry) => entry.id === command.id);
      if (page === undefined) return fail('editor.unknown-page');
      if (document.pages.length === 1) return fail('editor.last-page');
      const tree = documentTree(document);
      const removed = new Set(page.children.flatMap((child) => subtree(tree, child)));
      // The source deletion rule (M7 contract, section 5.4), as for `deleteNodes`.
      return withDetach(
        document,
        orphanedInstances(document, removed),
        context.ids,
        expansions,
        (draft) => {
          for (const id of removed) draft.remove(id);
          draft.setPages(document.pages.filter((entry) => entry !== page));
        },
        (draft) => success(finish(draft), draft, []),
      );
    }
    case 'renamePage': {
      if (typeof command.id !== 'string') return fail('editor.invalid-command', '/id');
      if (typeof command.name !== 'string') return fail('editor.invalid-command', '/name');
      const index = document.pages.findIndex((entry) => entry.id === command.id);
      if (index < 0) return fail('editor.unknown-page');
      const draft = new Draft(document);
      const pages = [...document.pages];
      pages[index] = { ...pages[index]!, name: command.name };
      draft.setPages(pages);
      return success(finish(draft), draft, []);
    }
    case 'movePage': {
      if (typeof command.id !== 'string') return fail('editor.invalid-command', '/id');
      const page = document.pages.find((entry) => entry.id === command.id);
      if (page === undefined) return fail('editor.unknown-page');
      // The index is into the list after the page is removed.
      if (!isIndex(command.index, document.pages.length - 1)) return fail('editor.invalid-index');
      const draft = new Draft(document);
      const rest = document.pages.filter((entry) => entry !== page);
      draft.setPages(inserted(rest, command.index, [page]));
      return success(finish(draft), draft, []);
    }
    default:
      return fail('editor.invalid-command', '/type');
  }
}

/**
 * The refit a gesture defers to its commit (section 4.2): groups whose children changed placement
 * between the gesture's `base` and `current` refit, innermost first.
 */
export function refitGesture(
  base: DocumentV6,
  current: DocumentV6,
  touched: Iterable<string>,
  custom: CustomRules = NO_CUSTOM,
  expansions: ExpansionCache = new ExpansionCache((node) => custom.check(node)),
): EditResult {
  const draft = new Draft(current);
  draft.adopt(touched);
  const document = draft.finish((node) => custom.check(node), { refit: true, placementBase: base });
  if ('ok' in document) return document;
  // The refit can change a group inside a source, so the expansions are checked again.
  const expansion = expansionFailure(document, expansions);
  if (expansion !== null) return expansion;
  return { ok: true, document, touched: [...draft.touched], created: [] };
}

/**
 * Package-internal gesture edits for the built-in tools, for placements no public command
 * expresses (M1 contract, section 4.4 and 7): `map` resizes a multi-selection by a page-space
 * scale, each node mapped from its pre-gesture state as in a group resize; `line` moves the
 * endpoints of a line to page points.
 */
export type GestureEdit =
  | Readonly<{ kind: 'map'; ids: readonly string[]; map: ScaleMap }>
  | Readonly<{ kind: 'line'; id: string; start: PagePoint; end: PagePoint }>;

/**
 * Applies a gesture edit to the live `document` of a gesture whose pre-gesture document is
 * `base`. Groups do not refit (that happens at commit, section 4.2).
 */
export function applyGestureEdit(
  document: DocumentV6,
  base: DocumentV6,
  edit: GestureEdit,
  custom: CustomRules = NO_CUSTOM,
  expansions: ExpansionCache = new ExpansionCache((node) => custom.check(node)),
  layout?: TextLayouter,
): EditResult {
  const draft = new Draft(document);
  if (edit.kind === 'map') {
    if (edit.ids.some((id) => nodeOf(document, id) === undefined)) {
      return fail('editor.unknown-node');
    }
    // Every mapped subtree first returns to its pre-gesture state, so updates do not compound
    // and a node the map leaves in place is back where it started.
    const baseTree = documentTree(base);
    for (const id of edit.ids) {
      for (const member of subtree(draft, id)) {
        const original = baseTree.node(member);
        if (original !== undefined && draft.node(member) !== original) {
          draft.setChecked(original, true);
        }
      }
    }
    for (const id of edit.ids) mapNodeInPageSpace(draft, id, edit.map);
  } else {
    const node = nodeOf(document, edit.id);
    if (node === undefined) return fail('editor.unknown-node');
    if (node.type !== 'line' || !isPoint(edit.start) || !isPoint(edit.end)) {
      return fail('editor.invalid-command');
    }
    // Into the parent's local space, as `createLine` maps them; on a page nothing changes.
    const inverse = invertRigid(spaceOf(draft, node.parent).matrix);
    const onPage = draft.page(node.parent) !== undefined;
    const start = onPage ? edit.start : apply(inverse, edit.start.x, edit.start.y);
    const end = onPage ? edit.end : apply(inverse, edit.end.x, edit.end.y);
    const { frame, unit } = fitPoints([start.x, start.y, end.x, end.y], node.rotation);
    draft.set({ ...node, frame, points: [unit[0]!, unit[1]!, unit[2]!, unit[3]!] });
  }
  // Text mapped by a uniform scale refits on every update (M6a contract, section 6.3).
  return success(
    draft.finish((node) => custom.check(node), { refit: false, expansions, layout }),
    draft,
    [],
  );
}

type CreateCommand = Extract<
  DocumentCommand,
  {
    type:
      | 'createRectangle'
      | 'createEllipse'
      | 'createFrame'
      | 'createLine'
      | 'createPath'
      | 'createCustomNode'
      | 'createInstance'
      | 'createText';
  }
>;

/**
 * Creation (section 4.1): the command's frame or points are in page space and are mapped into
 * the parent's local space. A failed create draws no ID (P5-U2), so `editor.duplicate-id` is the
 * last check here. `createInstance` (M7 contract, section 5.1) checks its `symbol` after the
 * `unknown-*` codes (`editor.not-a-symbol`), the M7-S5 tree depth with the parent's, nesting
 * (`editor.nested-symbol`) before the clip depth, and the clip depth through its expansion; its
 * other checks (validity, caps) run on a build with a placeholder ID, and a failure at the new
 * instance has a path relative to it, as every creation failure. `createText` (M6a contract,
 * section 6.1) checks after the model's rules the authored size floor and `editor.no-text-layout`
 * for an auto mode without a port (a text node may sit in a source, section 9, M7-T1), and lays
 * out its auto dimensions in page space with the growth anchor on the given frame before
 * placement.
 */
function create(
  document: DocumentV6,
  command: CreateCommand,
  context: EditContext,
  custom: CustomRules,
  finish: (draft: Draft) => DocumentV6 | Failure,
): EditResult {
  if (command.parent !== undefined && typeof command.parent !== 'string') {
    return fail('editor.invalid-command', '/parent');
  }
  // Interleaved page points of a path or line; frame-based nodes have none.
  let points: number[] | null = null;
  if (command.type === 'createPath') {
    const raw: unknown = command.points;
    if (!Array.isArray(raw) || raw.length < 2) return fail('editor.invalid-command', '/points');
    for (let i = 0; i < raw.length; i += 1) {
      if (typeof raw[i] !== 'number' || !Number.isFinite(raw[i])) {
        return fail('editor.invalid-command', `/points/${i}`);
      }
    }
    points = [...(raw as number[])];
  } else if (command.type === 'createLine') {
    if (!isPoint(command.start)) return fail('editor.invalid-command', '/start');
    if (!isPoint(command.end)) return fail('editor.invalid-command', '/end');
    points = [command.start.x, command.start.y, command.end.x, command.end.y];
  }
  if (command.type === 'createInstance' && typeof command.symbol !== 'string') {
    return fail('editor.invalid-command', '/symbol');
  }
  const tree = documentTree(document);
  const parent = command.parent ?? context.activePage;
  const onPage = tree.page(parent) !== undefined;
  const owner = tree.node(parent);
  if (!onPage && owner === undefined) return fail('editor.unknown-node');
  let source: SymbolNodeV6 | null = null;
  if (command.type === 'createInstance') {
    const named = nodeOf(document, command.symbol);
    if (named === undefined) return fail('editor.unknown-node');
    if (named.type !== 'symbol') return fail('editor.not-a-symbol');
    source = named;
  }
  const siblings = childrenOf(tree, parent);
  const index = command.index ?? siblings.length;
  if (!isIndex(index, siblings.length)) return fail('editor.invalid-index');
  const rotation: unknown = command.rotation ?? 0;
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
    return fail('document.invalid-field', '/rotation');
  }

  // The node in page space, validated before an ID is drawn; failure paths are relative to it.
  const base = {
    id: PENDING_ID,
    parent: PENDING_ID,
    rotation,
    constraints: START,
    opacity: 1,
    visible: true,
  };
  const fitted = points === null ? null : fitPoints(points, normalizeRotation(rotation));
  let candidate: Record<string, unknown>;
  switch (command.type) {
    case 'createRectangle':
      candidate = {
        ...base,
        name: command.name ?? 'Rectangle',
        frame: command.frame,
        type: 'rectangle',
        cornerRadii: command.cornerRadii ?? [0, 0, 0, 0],
        fill: command.fill === undefined ? DEFAULT_RECTANGLE_FILL : command.fill,
        stroke: command.stroke ?? null,
      };
      break;
    case 'createEllipse':
      candidate = {
        ...base,
        name: command.name ?? 'Ellipse',
        frame: command.frame,
        type: 'ellipse',
        fill: command.fill === undefined ? DEFAULT_RECTANGLE_FILL : command.fill,
        stroke: command.stroke ?? null,
      };
      break;
    case 'createFrame':
      candidate = {
        ...base,
        name: command.name ?? 'Frame',
        frame: command.frame,
        type: 'frame',
        children: [],
        fill: command.fill === undefined ? DEFAULT_FRAME_FILL : command.fill,
        stroke: command.stroke ?? null,
      };
      break;
    case 'createLine':
      candidate = {
        ...base,
        name: command.name ?? 'Line',
        frame: fitted!.frame,
        type: 'line',
        points: fitted!.unit,
        stroke: command.stroke === undefined ? DEFAULT_PATH_STROKE : command.stroke,
        startArrow: command.startArrow ?? 'none',
        endArrow: command.endArrow ?? 'none',
      };
      break;
    case 'createPath':
      candidate = {
        ...base,
        name: command.name ?? 'Path',
        frame: fitted!.frame,
        type: 'path',
        path: {
          verbs: command.verbs,
          points: fitted!.unit,
          fillRule: command.fillRule ?? 'nonzero',
        },
        fill: command.fill ?? null,
        stroke: command.stroke === undefined ? DEFAULT_PATH_STROKE : command.stroke,
      };
      break;
    case 'createCustomNode': {
      let data = command.data;
      if (data === undefined) {
        const defaults = custom.defaults(command.customType);
        if ('code' in defaults) return fail(defaults.code, defaults.path);
        data = defaults.data;
      }
      candidate = {
        ...base,
        name: command.name ?? command.customType,
        frame: command.frame,
        type: 'custom',
        customType: command.customType,
        data,
        fill: command.fill ?? null,
        stroke: command.stroke === undefined ? DEFAULT_PATH_STROKE : command.stroke,
      };
      break;
    }
    case 'createText':
      candidate = {
        ...base,
        name: 'Text',
        frame: command.frame,
        type: 'text',
        runs: command.runs,
        sizing: command.sizing ?? 'autoWidth',
        align: command.align ?? 'left',
        letterSpacing: command.letterSpacing ?? 0,
        lineHeight: command.lineHeight ?? TEXT_LINE_HEIGHT,
      };
      break;
    case 'createInstance': {
      // By default the source's size, beside its page bounds (section 5.1), on the active page.
      const bounds = boundsOf(document, [source!.id])!;
      candidate = {
        ...base,
        name: source!.name,
        // A given frame, `null` included, is checked by the model's field rules as for others.
        frame:
          command.frame !== undefined
            ? command.frame
            : {
                x: bounds.x + bounds.width + 40,
                y: bounds.y,
                width: source!.frame.width,
                height: source!.frame.height,
              },
        type: 'instance',
        symbol: source!.id,
        textOverrides: {},
      };
      break;
    }
  }
  let result: ReturnType<typeof validateNode>;
  try {
    result = validateNode(candidate);
  } catch {
    // Only extension `defaults()` can put an exotic value (a throwing getter or proxy) here.
    return fail('document.invalid-custom-data', '/data');
  }
  if (!result.ok) return fail(result.code, result.path);
  const inSymbol =
    owner?.type === 'symbol' || ancestors(tree, parent).some((node) => node.type === 'symbol');
  if (result.node.type === 'text') {
    const text = textChecks(result.node, context.layout);
    if ('ok' in text) return text;
    result = { ok: true, node: text };
  }
  const depth = onPage ? 0 : treeDepth(tree, parent) + 1;
  // An instance's expanded nodes sit below it by its source's height (M7-S5).
  const height = source === null ? 0 : sourceHeight(tree, source.id);
  if (depth + height > MAX_TREE_DEPTH) return fail('document.invalid-field', '/parent');
  const rejected = custom.check(deepFreeze(result.node));
  if (rejected !== null) return fail(rejected.code, rejected.path);
  if (!onPage && !isContainer(owner)) return fail('editor.invalid-parent', '/parent');
  if (owner?.type === 'maskGroup' && index === 0 && result.node.type !== 'path') {
    return fail('editor.invalid-mask-source', '/index');
  }
  if (source !== null && inSymbol) return fail('editor.nested-symbol', '/parent');
  const clips = childClipDepth(tree, parent);
  if (
    clips > MAX_CLIP_DEPTH ||
    (result.node.type === 'frame' && clips > MAX_CLIP_CONTAINER_DEPTH) ||
    (source !== null && instanceClipBreaks(clips, sourceClipLevels(tree, source.id)))
  ) {
    return fail('editor.clip-depth', '/parent');
  }
  // Then the isolation count of the new node (MVP M4 contract, section 4.3): a new instance of a
  // translucent source isolates by its effective opacity.
  if (isolationBreaks(tree, result.node, childIsolationCount(tree, parent))) {
    return fail('editor.isolation-depth', '/parent');
  }
  const build = (id: string): EditResult => {
    // Into the parent's local space; on a page nothing changes.
    let placed: NodeV6 = { ...result.node, id, parent };
    if (!onPage) {
      const space = spaceOf(tree, parent);
      const local = normalizeRotation(result.node.rotation - space.rotation);
      if (points !== null) {
        const inverse = invertRigid(space.matrix);
        const mapped: number[] = [];
        for (let i = 0; i + 1 < points.length; i += 2) {
          const p = apply(inverse, points[i]!, points[i + 1]!);
          mapped.push(p.x, p.y);
        }
        const { frame, unit } = fitPoints(mapped, local);
        if (placed.type === 'path') {
          placed = { ...placed, frame, rotation: local, path: { ...placed.path, points: unit } };
        } else if (placed.type === 'line') {
          placed = {
            ...placed,
            frame,
            rotation: local,
            points: [unit[0]!, unit[1]!, unit[2]!, unit[3]!],
          };
        }
      } else {
        placed = {
          ...placed,
          ...relocate(placed.frame, placed.rotation, IDENTITY, 0, space.matrix, space.rotation),
        };
      }
      const mapped = validateNode(placed);
      if (!mapped.ok) return fail(mapped.code, mapped.path);
      placed = mapped.node;
    }
    const draft = new Draft(document);
    draft.setChecked(placed, true);
    draft.setChildren(parent, inserted(siblings, index, [id]));
    return success(finish(draft), draft, [id], [id]);
  };
  // A node created inside a source changes every instance of it, and a new instance adds an
  // expansion, so the expansion checks run on a build with a placeholder ID first, and a failed
  // command draws no ID (M7 section 5.5).
  if (inSymbol || source !== null) {
    const placeholder = placeholderIds(document, 1)[0]!;
    const trial = build(placeholder);
    if (!trial.ok) return relativeToNew(trial, nodePath(placeholder));
  }
  const id = freshId(document, context.ids);
  if (id === null) return fail('editor.duplicate-id');
  return build(id);
}

/** The keys of `setStyle`'s `style` and of a stroke patch (MVP M4 contract, section 4.2). */
const STYLE_KEYS = ['fill', 'stroke', 'opacity', 'cornerRadii'];
const STROKE_KEYS = ['color', 'width', 'cap', 'join', 'miterLimit', 'dash'];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `setStyle` (MVP M4 contract, section 4.2): `ids` a non-empty list of distinct strings, each a
 * node of the active page at any depth; `style` an object with at least one of `fill`, `stroke`,
 * `opacity` and `cornerRadii`, each applying to at least one listed node (`PROPS`); a stroke
 * patch an object with known keys or `null`. Each node with a changed value is merged and
 * validated in `ids` order, then the document's checks run as for every command (`success`:
 * the isolation count, the expansions and caps). With no value changed the base document is
 * returned, which the editor records as no step.
 */
function setStyle(
  document: DocumentV6,
  command: Extract<DocumentCommand, { type: 'setStyle' }>,
  context: EditContext,
  custom: CustomRules,
  finish: (draft: Draft) => DocumentV6 | Failure,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
  const tree = documentTree(document);
  if (
    ids.some((id) => nodeOf(document, id) === undefined || pageOf(tree, id) !== context.activePage)
  ) {
    return fail('editor.unknown-node');
  }
  const style: unknown = command.style;
  if (!isPlainRecord(style) || Object.keys(style).length === 0) {
    return fail('editor.invalid-command', '/style');
  }
  const keys = Object.keys(style);
  for (const key of keys) {
    if (!STYLE_KEYS.includes(key)) return fail('editor.invalid-command', pointerTo('/style', key));
  }
  const nodes = ids.map((id) => document.nodes[id]!);
  for (const key of keys) {
    if (!nodes.some((node) => PROPS[node.type].includes(key))) {
      return fail('editor.invalid-command', `/style/${key}`);
    }
  }
  const patch = style.stroke;
  if (patch !== undefined && patch !== null) {
    if (!isPlainRecord(patch)) return fail('editor.invalid-command', '/style/stroke');
    for (const key of Object.keys(patch)) {
      if (!STROKE_KEYS.includes(key)) {
        return fail('editor.invalid-command', pointerTo('/style/stroke', key));
      }
    }
  }
  const changed: NodeV6[] = [];
  for (const node of nodes) {
    const props: Record<string, unknown> = {};
    for (const key of keys) {
      if (!PROPS[node.type].includes(key)) continue;
      if (key !== 'stroke' || patch === null) {
        props[key] = style[key];
        continue;
      }
      const own = (node as { stroke: Stroke | null }).stroke;
      const fallback =
        node.type === 'line' || node.type === 'path' || node.type === 'custom'
          ? DEFAULT_PATH_STROKE
          : DEFAULT_SHAPE_STROKE;
      props.stroke = { ...(own ?? fallback), ...(patch as Record<string, unknown>) };
    }
    if (Object.keys(props).length === 0) continue;
    const result = validateNode({ ...node, ...props });
    if (!result.ok) return fail(result.code, nodePath(node.id, result.path));
    const rejected = custom.check(deepFreeze(result.node));
    if (rejected !== null) return fail(rejected.code, nodePath(node.id, rejected.path));
    const next = result.node as Record<string, unknown>;
    const before = node as Record<string, unknown>;
    if (
      Object.keys(props).every((key) => JSON.stringify(next[key]) === JSON.stringify(before[key]))
    ) {
      continue;
    }
    changed.push(result.node);
  }
  if (changed.length === 0) return { ok: true, document, touched: [], created: [] };
  const draft = new Draft(document);
  for (const node of changed) draft.setChecked(node, true);
  return success(finish(draft), draft, []);
}

/** A JSON Pointer to `key` below `prefix`. */
function pointerTo(prefix: string, key: string): string {
  return `${prefix}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/**
 * The `createText` checks after the model's rules (M6a contract, section 6.1): the authored size
 * floor at `/runs/<k>/size`, then `editor.no-text-layout` for an auto mode without a port; a text
 * node may be created inside a source (section 9, M7-T1). On success the node in page space with
 * its auto dimensions laid out, the
 * growth anchor `(x + a·width, y)` of the given frame kept (section 6.2).
 */
function textChecks(node: TextNode, layout: TextLayouter | undefined): TextNode | Failure {
  const small = node.runs.findIndex((run) => run.size < MIN_AUTHORED_TEXT_SIZE);
  if (small >= 0) return fail('editor.invalid-command', `/runs/${small}/size`);
  if (isAuto(node) && layout === undefined) return fail('editor.no-text-layout');
  if (layout === undefined || !isAuto(node)) return node;
  const frame = refitFrame(node, layout(node));
  if (frame === node.frame) return node;
  const laid = validateNode({ ...node, frame });
  return laid.ok ? (laid.node as TextNode) : fail(laid.code, laid.path);
}

/**
 * `createSymbol` (M7 contract, section 5.1): sibling nodes of the active page, checked as
 * `groupNodes` checks them (`ids` shape, `editor.unknown-node`, `editor.not-siblings`). One
 * `frame` becomes a `symbol` in place (same ID, fields and children); otherwise a new `symbol`
 * wraps the nodes as `groupNodes` does, named `Symbol`, with fill and stroke null. A source
 * that would hold or sit in a source fails with `editor.nested-symbol` (section 5.3).
 */
function createSymbol(
  document: DocumentV6,
  command: Extract<DocumentCommand, { type: 'createSymbol' }>,
  context: EditContext,
  finish: (draft: Draft) => DocumentV6 | Failure,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null) return fail('editor.invalid-command', '/ids');
  const tree = documentTree(document);
  if (
    ids.some((id) => nodeOf(document, id) === undefined || pageOf(tree, id) !== context.activePage)
  ) {
    return fail('editor.unknown-node');
  }
  const owner = ids.length === 0 ? undefined : document.nodes[ids[0]!]!.parent;
  if (owner === undefined || ids.some((member) => document.nodes[member]!.parent !== owner)) {
    return fail('editor.not-siblings');
  }
  const only = document.nodes[ids[0]!]!;
  if (ids.length === 1 && only.type === 'frame') {
    const draft = new Draft(document);
    draft.set({ ...only, type: 'symbol' });
    const result = success(finish(draft), draft, []);
    return result.ok ? { ...result, ids: [only.id] } : result;
  }
  const placeholder = placeholderId(document);
  const trial = buildGroup(document, 'symbol', ids, owner, placeholder, finish);
  if (!trial.ok) return relativeToNew(trial, nodePath(placeholder));
  const id = freshId(document, context.ids);
  if (id === null) return fail('editor.duplicate-id');
  return buildGroup(document, 'symbol', ids, owner, id, finish);
}

/** `groupNodes` (section 4.3). */
function group(
  document: DocumentV6,
  command: Extract<DocumentCommand, { type: 'groupNodes' }>,
  context: EditContext,
  finish: (draft: Draft) => DocumentV6 | Failure,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null) return fail('editor.invalid-command', '/ids');
  if (command.kind !== 'group' && command.kind !== 'maskGroup') {
    return fail('editor.invalid-command', '/kind');
  }
  if (ids.some((id) => nodeOf(document, id) === undefined)) return fail('editor.unknown-node');
  const owner = ids.length === 0 ? undefined : document.nodes[ids[0]!]!.parent;
  if (owner === undefined || ids.some((member) => document.nodes[member]!.parent !== owner)) {
    return fail('editor.not-siblings');
  }
  // Every check runs with a placeholder ID first, so a failed command draws no ID; the result
  // does not depend on the ID, so the build with the drawn one passes too.
  const placeholder = placeholderId(document);
  const trial = buildGroup(document, command.kind, ids, owner, placeholder, finish);
  if (!trial.ok) return relativeToNew(trial, nodePath(placeholder));
  const id = freshId(document, context.ids);
  if (id === null) return fail('editor.duplicate-id');
  return buildGroup(document, command.kind, ids, owner, id, finish);
}

/** A failure inside the new container is reported relative to it, as for creation commands. */
function relativeToNew(failure: Failure, prefix: string): Failure {
  const path = failure.path;
  if (path === undefined || (path !== prefix && !path.startsWith(`${prefix}/`))) return failure;
  return fail(failure.code, path.slice(prefix.length) || undefined);
}

/** An ID that no page or node of `document` has, for checks that run before the ID is drawn. */
function placeholderId(document: DocumentV6): string {
  let id = PENDING_ID;
  for (
    let n = 1;
    document.pages.some((page) => page.id === id) || Object.hasOwn(document.nodes, id);
    n += 1
  ) {
    id = `${PENDING_ID}-${n}`;
  }
  return id;
}

function buildGroup(
  document: DocumentV6,
  kind: 'group' | 'maskGroup' | 'symbol',
  ids: readonly string[],
  owner: string,
  id: string,
  finish: (draft: Draft) => DocumentV6 | Failure,
): EditResult {
  const siblings = childrenOf(documentTree(document), owner);
  const members = siblings.filter((child) => ids.includes(child));
  const nodes = members.map((member) => document.nodes[member]!);
  // The new container's frame is the bounds of their rotated frames, rotation 0; a source,
  // which clips its content, takes their visual bounds instead, strokes and arrowheads included
  // (M7 contract, section 5.1, from the M7-U6 hands-on check).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const b = kind === 'symbol' ? visualBounds(document, node) : rotatedBounds(node);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const shared = {
    id,
    parent: owner,
    frame: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    children: members,
  };
  // A source wraps the nodes as a group does, with no fill or stroke (M7 contract, section 5.1).
  const container: NodeV6 =
    kind === 'symbol'
      ? { ...shared, name: 'Symbol', type: 'symbol', fill: null, stroke: null }
      : { ...shared, name: kind === 'group' ? 'Group' : 'Mask group', type: kind };
  const draft = new Draft(document);
  draft.set(container);
  for (const node of nodes) {
    draft.set({
      ...node,
      parent: id,
      frame: { ...node.frame, x: node.frame.x - minX, y: node.frame.y - minY },
    });
  }
  // The container takes the place of the topmost member in paint order.
  const top = siblings.indexOf(members[members.length - 1]!) - (members.length - 1);
  draft.setChildren(
    owner,
    inserted(
      siblings.filter((child) => !ids.includes(child)),
      top,
      [id],
    ),
  );
  const deep = treeDepthViolation(draft, [id]);
  if (deep !== null) return fail('document.invalid-field', nodePath(deep, '/parent'));
  return success(finish(draft), draft, [id], [id]);
}

/** `moveNodes` (section 4.3): reparenting within one page, keeping page placement. */
function move(
  document: DocumentV6,
  command: Extract<DocumentCommand, { type: 'moveNodes' }>,
  finish: (draft: Draft) => DocumentV6 | Failure,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
  if (typeof command.parent !== 'string') return fail('editor.invalid-command', '/parent');
  if (ids.some((id) => nodeOf(document, id) === undefined)) return fail('editor.unknown-node');
  const tree = documentTree(document);
  const target = command.parent;
  const targetPage = tree.page(target) !== undefined ? target : pageOf(tree, target);
  if (targetPage === undefined) return fail('editor.unknown-node');
  const listed = new Set(ids);
  const roots = ids.filter((id) => !ancestors(tree, id).some((node) => listed.has(node.id)));
  const remaining = childrenOf(tree, target).filter((child) => !roots.includes(child));
  if (!isIndex(command.index, remaining.length)) return fail('editor.invalid-index');
  const targetNode = tree.node(target);
  if (
    (targetNode !== undefined && !isContainer(targetNode)) ||
    roots.some(
      (id) => id === target || isAncestor(tree, id, target) || pageOf(tree, id) !== targetPage,
    )
  ) {
    return fail('editor.invalid-parent', '/parent');
  }
  // The moved nodes keep their document pre-order.
  const order = new Map(
    document.pages
      .find((page) => page.id === targetPage)!
      .children.flatMap((child) => subtree(tree, child))
      .map((id, position) => [id, position] as const),
  );
  roots.sort((a, b) => order.get(a)! - order.get(b)!);
  const to = spaceOf(tree, target);
  const draft = new Draft(document);
  for (const id of roots) {
    const owner = document.nodes[id]!.parent;
    draft.setChildren(
      owner,
      childrenOf(draft, owner).filter((child) => child !== id),
    );
  }
  for (const id of roots) {
    const node = document.nodes[id]!;
    if (node.parent === target) {
      // A reorder within one parent keeps the node exactly.
      draft.setChecked(node, true);
      continue;
    }
    const from = spaceOf(tree, node.parent);
    const moved = relocate(
      node.frame,
      node.rotation,
      from.matrix,
      from.rotation,
      to.matrix,
      to.rotation,
    );
    draft.set({ ...node, parent: target, ...moved });
  }
  draft.setChildren(target, inserted(childrenOf(draft, target), command.index, roots));
  const deep = treeDepthViolation(draft, roots);
  if (deep !== null) return fail('document.invalid-field', nodePath(deep, '/parent'));
  return success(finish(draft), draft, [], roots);
}

/**
 * `rotateNodes` (MVP M2 contract, section 4.1): each listed node's page rotation `θ` (its parent
 * chain's rotation plus its own) becomes `normalize(θ + angle)`, stored minus the chain's; its
 * frame centre turns by `angle` about the page point `pivot` in page space and maps back into
 * its parent space; its size is kept. Containers turn rigidly (children are parent-local), and
 * group ancestors refit when `context.refit` holds. With one listed node and no `pivot`, the
 * node keeps its stored `x` and `y`. A rotation that changes no node returns the document
 * itself with nothing touched, which the editor records as no step.
 */
function rotateNodes(
  document: DocumentV6,
  command: Extract<DocumentCommand, { type: 'rotateNodes' }>,
  context: EditContext,
  finish: (draft: Draft) => DocumentV6 | Failure,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
  const angle: unknown = command.angle;
  if (typeof angle !== 'number' || !Number.isFinite(angle)) {
    return fail('editor.invalid-command', '/angle');
  }
  if (command.pivot !== undefined && !isPoint(command.pivot)) {
    return fail('editor.invalid-command', '/pivot');
  }
  const tree = documentTree(document);
  if (
    ids.some((id) => nodeOf(document, id) === undefined || pageOf(tree, id) !== context.activePage)
  ) {
    return fail('editor.unknown-node');
  }
  // A listed descendant of a listed node turns with its ancestor (the M1 selection rule).
  const listed = new Set(ids);
  const roots = ids.filter((id) => !ancestors(tree, id).some((node) => listed.has(node.id)));
  const unchanged: EditResult = { ok: true, document, touched: [], created: [] };
  // A whole number of turns changes nothing.
  if (normalizeRotation(angle) === 0) return unchanged;
  const keepPosition = roots.length === 1 && command.pivot === undefined;
  const pivot = command.pivot ?? handleCentre(handleBoxOf(document, context.activePage, roots)!);
  const draft = new Draft(document);
  for (const id of roots) {
    const node = document.nodes[id]!;
    const space = spaceOf(tree, node.parent);
    const rotation = normalizeRotation(
      normalizeRotation(space.rotation + node.rotation + angle) - space.rotation,
    );
    let frame = node.frame;
    if (!keepPosition) {
      const { x, y, width, height } = node.frame;
      const onPage = tree.page(node.parent) !== undefined;
      const centre = onPage
        ? { x: x + width / 2, y: y + height / 2 }
        : apply(space.matrix, x + width / 2, y + height / 2);
      const d = rotate(angle, centre.x - pivot.x, centre.y - pivot.y);
      const turned = { x: pivot.x + d.x, y: pivot.y + d.y };
      const local = onPage ? turned : apply(invertRigid(space.matrix), turned.x, turned.y);
      frame = { x: local.x - width / 2, y: local.y - height / 2, width, height };
    }
    const same = rotation === node.rotation && frame.x === node.frame.x && frame.y === node.frame.y;
    if (!same) draft.set({ ...node, frame, rotation });
  }
  if (draft.touched.size === 0) return unchanged;
  return success(finish(draft), draft, []);
}
