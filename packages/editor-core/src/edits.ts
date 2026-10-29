import {
  MAX_TREE_DEPTH,
  normalizeRotation,
  validateNode,
  type DocumentV3,
  type Frame,
  type NodeV3,
  type PageV2,
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
import { handleBoxOf, handleCentre } from './handles.js';
import {
  ancestors,
  childrenOf,
  clipDepth,
  clipsChildren,
  documentTree,
  isAncestor,
  isContainer,
  isGroup,
  nodePath,
  pageOf,
  spaceOf,
  subtree,
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
} as const);
export const DEFAULT_FRAME_FILL = deepFreeze({ r: 1, g: 1, b: 1, a: 1 } as const);
const START = deepFreeze({ horizontal: 'start', vertical: 'start' } as const);

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
const PROPS: Readonly<Record<NodeV3['type'], readonly string[]>> = {
  rectangle: [...COMMON_PROPS, 'fill', 'stroke', 'cornerRadii'],
  ellipse: [...COMMON_PROPS, 'fill', 'stroke'],
  line: [...COMMON_PROPS, 'stroke', 'startArrow', 'endArrow'],
  path: [...COMMON_PROPS, 'fill', 'stroke'],
  custom: [...COMMON_PROPS, 'fill', 'stroke', 'data'],
  group: COMMON_PROPS,
  maskGroup: COMMON_PROPS,
  frame: [...COMMON_PROPS, 'fill', 'stroke'],
  // M7 contract: a symbol has a frame's props (section 1.2), an instance only the common ones
  // (section 5.1). Their commands and tests come with M7-U4.
  symbol: [...COMMON_PROPS, 'fill', 'stroke'],
  instance: COMMON_PROPS,
};

/**
 * Whether removing `removed` would leave an instance outside it naming a symbol inside it. Interim
 * until M7-U4 adds the source deletion rule (M7 contract, section 5.4): until then `deleteNodes`,
 * `cut` and `removePage` fail with `editor.invalid-command` and change nothing.
 */
function strandsInstances(document: DocumentV3, removed: ReadonlySet<string>): boolean {
  return Object.values(document.nodes).some(
    (node) => node.type === 'instance' && !removed.has(node.id) && removed.has(node.symbol),
  );
}

/** Whether the subtree of `id` holds a `symbol` or an `instance`. */
function holdsSymbolNode(tree: TreeView, id: string): boolean {
  return subtree(tree, id).some((entry) => {
    const type = tree.node(entry)?.type;
    return type === 'symbol' || type === 'instance';
  });
}

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
function restoreSubtree(draft: Draft, base: DocumentV3, id: string): Frame | null {
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
  document: DocumentV3,
  command: DocumentCommand,
  context: EditContext,
): EditResult {
  const custom = context.custom ?? NO_CUSTOM;
  const refit = context.refit ?? true;
  const expansions = context.expansions ?? new ExpansionCache((node) => custom.check(node));
  const finish = (draft: Draft) =>
    draft.finish((node) => custom.check(node), { refit, expansions });
  switch (command.type) {
    case 'createRectangle':
    case 'createEllipse':
    case 'createFrame':
    case 'createLine':
    case 'createPath':
    case 'createCustomNode':
      return create(document, command, context, custom, finish);
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
      const next: NodeV3[] = [];
      for (const entry of entries) {
        const node = document.nodes[entry.id]!;
        const rotation = entry.rotation === undefined ? node.rotation : entry.rotation;
        const result = validateNode({ ...node, frame: entry.frame, rotation });
        if (!result.ok) return fail(result.code, nodePath(entry.id, result.path));
        const rejected = custom.check(deepFreeze(result.node));
        if (rejected !== null) return fail(rejected.code, nodePath(entry.id, rejected.path));
        next.push(result.node);
      }
      const draft = new Draft(document);
      for (const node of next) {
        let before = draft.node(node.id)!.frame;
        draft.setChecked(node, true);
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
    case 'deleteNodes': {
      const ids = uniqueIds(command.ids);
      if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
      if (ids.some((id) => nodeOf(document, id) === undefined)) return fail('editor.unknown-node');
      const tree = documentTree(document);
      const listed = new Set(ids);
      // A listed descendant of a listed node goes with its ancestor.
      const roots = ids.filter((id) => !ancestors(tree, id).some((node) => listed.has(node.id)));
      const removed = new Set(roots.flatMap((id) => subtree(tree, id)));
      if (strandsInstances(document, removed)) return fail('editor.invalid-command', '/ids');
      const draft = new Draft(document);
      for (const id of roots) {
        const owner = document.nodes[id]!.parent;
        draft.setChildren(
          owner,
          childrenOf(draft, owner).filter((child) => child !== id),
        );
        for (const removed of subtree(tree, id)) draft.remove(removed);
      }
      return success(finish(draft), draft, []);
    }
    case 'groupNodes':
      return group(document, command, context, finish);
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
      const space = localTransform(node.frame, node.rotation);
      for (const id of node.children) {
        const child = document.nodes[id]!;
        const moved = relocate(child.frame, child.rotation, space, node.rotation, IDENTITY, 0);
        draft.set({ ...child, parent: owner, ...moved });
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
      if (strandsInstances(document, removed)) return fail('editor.invalid-command', '/id');
      const draft = new Draft(document);
      for (const id of removed) draft.remove(id);
      draft.setPages(document.pages.filter((entry) => entry !== page));
      return success(finish(draft), draft, []);
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
  base: DocumentV3,
  current: DocumentV3,
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
  document: DocumentV3,
  base: DocumentV3,
  edit: GestureEdit,
  custom: CustomRules = NO_CUSTOM,
  expansions: ExpansionCache = new ExpansionCache((node) => custom.check(node)),
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
  return success(
    draft.finish((node) => custom.check(node), { refit: false, expansions }),
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
      | 'createCustomNode';
  }
>;

/**
 * Creation (section 4.1): the command's frame or points are in page space and are mapped into
 * the parent's local space. A failed create draws no ID (P5-U2), so `editor.duplicate-id` is the
 * last check here.
 */
function create(
  document: DocumentV3,
  command: CreateCommand,
  context: EditContext,
  custom: CustomRules,
  finish: (draft: Draft) => DocumentV3 | Failure,
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
  const tree = documentTree(document);
  const parent = command.parent ?? context.activePage;
  const onPage = tree.page(parent) !== undefined;
  const owner = tree.node(parent);
  if (!onPage && owner === undefined) return fail('editor.unknown-node');
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
  }
  let result: ReturnType<typeof validateNode>;
  try {
    result = validateNode(candidate);
  } catch {
    // Only extension `defaults()` can put an exotic value (a throwing getter or proxy) here.
    return fail('document.invalid-custom-data', '/data');
  }
  if (!result.ok) return fail(result.code, result.path);
  const depth = onPage ? 0 : treeDepth(tree, parent) + 1;
  if (depth > MAX_TREE_DEPTH) return fail('document.invalid-field', '/parent');
  const rejected = custom.check(deepFreeze(result.node));
  if (rejected !== null) return fail(rejected.code, rejected.path);
  if (!onPage && !isContainer(owner)) return fail('editor.invalid-parent', '/parent');
  if (owner?.type === 'maskGroup' && index === 0 && result.node.type !== 'path') {
    return fail('editor.invalid-mask-source', '/index');
  }
  const clips = childClipDepth(tree, parent);
  if (
    clips > MAX_CLIP_DEPTH ||
    (result.node.type === 'frame' && clips > MAX_CLIP_CONTAINER_DEPTH)
  ) {
    return fail('editor.clip-depth', '/parent');
  }
  const build = (id: string): EditResult => {
    // Into the parent's local space; on a page nothing changes.
    let placed: NodeV3 = { ...result.node, id, parent };
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
  // A node created inside a source changes every instance of it, so the expansion checks run
  // on a build with a placeholder ID first, and a failed command draws no ID (M7 section 5.5).
  if (owner?.type === 'symbol' || ancestors(tree, parent).some((node) => node.type === 'symbol')) {
    const trial = build(placeholderIds(document, 1)[0]!);
    if (!trial.ok) return trial;
  }
  const id = freshId(document, context.ids);
  if (id === null) return fail('editor.duplicate-id');
  return build(id);
}

/** `groupNodes` (section 4.3). */
function group(
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'groupNodes' }>,
  context: EditContext,
  finish: (draft: Draft) => DocumentV3 | Failure,
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
function placeholderId(document: DocumentV3): string {
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
  document: DocumentV3,
  kind: 'group' | 'maskGroup',
  ids: readonly string[],
  owner: string,
  id: string,
  finish: (draft: Draft) => DocumentV3 | Failure,
): EditResult {
  const siblings = childrenOf(documentTree(document), owner);
  const members = siblings.filter((child) => ids.includes(child));
  const nodes = members.map((member) => document.nodes[member]!);
  // The new container's frame is the bounds of their rotated frames, rotation 0.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const b = rotatedBounds(node);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const container: NodeV3 = {
    id,
    name: kind === 'group' ? 'Group' : 'Mask group',
    parent: owner,
    frame: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: kind,
    children: members,
  };
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
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'moveNodes' }>,
  finish: (draft: Draft) => DocumentV3 | Failure,
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
  // Interim until M7-U4's `editor.nested-symbol` (M7 contract, section 5.3): no symbol or instance
  // moves into a symbol (M7-S3).
  const intoSymbol =
    targetNode?.type === 'symbol' || ancestors(tree, target).some((node) => node.type === 'symbol');
  if (intoSymbol && roots.some((id) => holdsSymbolNode(tree, id))) {
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
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'rotateNodes' }>,
  context: EditContext,
  finish: (draft: Draft) => DocumentV3 | Failure,
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
