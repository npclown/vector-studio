import {
  isValidId,
  MAX_TREE_DEPTH,
  normalizeRotation,
  validateNode,
  type DocumentV2,
  type Frame,
  type NodeV2,
  type PageV2,
} from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import type { CustomDefaults, CustomFailure } from './extensions.js';
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
import { mapNodeInPageSpace, resizeContainer, type ScaleMap } from './resize.js';
import { handleBoxOf, handleCentre } from './handles.js';
import { boundsOf } from './hit-test.js';
import {
  ancestors,
  childrenOf,
  clipDepth,
  clipDepthViolation,
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
import type { AlignEdge, DocumentCommand, IdSource, PagePoint, ReorderOp } from './types.js';

// Pure document edits: each takes a valid document and returns a new valid document, or a
// failure that leaves nothing changed. Nodes are validated with the model's own field rules.
// MVP M1 contract, sections 3 and 4: pages, creation with placement, placement edits with the
// resize rules and group refit, grouping and reparenting, and the clip and tree depth bounds.
// Failures follow the precedence of section 4.3.1.

export { deepFreeze };

export type EditResult =
  | Readonly<{
      ok: true;
      document: DocumentV2;
      /** Nodes created, changed or removed. */
      touched: readonly string[];
      /** Nodes or pages the command created. */
      created: readonly string[];
    }>
  | Failure;

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

/** The extension checks edits need (an `ExtensionRegistry`). */
export type CustomRules = Readonly<{
  check(node: NodeV2): CustomFailure | null;
  defaults(customType: string): CustomDefaults;
}>;

const NO_CUSTOM: CustomRules = {
  check: (node) =>
    node.type === 'custom' ? { code: 'document.unknown-custom-type', path: '/customType' } : null,
  defaults: () => ({ code: 'document.unknown-custom-type', path: '/customType' }),
};

export type EditContext = Readonly<{
  ids: IdSource;
  custom?: CustomRules;
  /** Creation without `parent` uses this page's root. */
  activePage: string;
  /** False during a gesture update: groups refit only at commit (section 4.2). */
  refit?: boolean;
  /**
   * A gesture's pre-gesture document. A container resized during the gesture applies the resize
   * rules from its state there, so each update is independent of the ones before it.
   */
  resizeBase?: DocumentV2;
}>;

const ID_ATTEMPTS = 1000;
const PENDING_ID = 'pending';
/** Clip levels a frame or mask group, and any node, may sit at (section 4.3). */
const MAX_CLIP_CONTAINER_DEPTH = 31;
const MAX_CLIP_DEPTH = 32;

/** The props each node type has (section 4.2); any other prop is `editor.invalid-command`. */
const COMMON_PROPS = ['name', 'opacity', 'visible', 'constraints'];
const PROPS: Readonly<Record<NodeV2['type'], readonly string[]>> = {
  rectangle: [...COMMON_PROPS, 'fill', 'stroke', 'cornerRadii'],
  ellipse: [...COMMON_PROPS, 'fill', 'stroke'],
  line: [...COMMON_PROPS, 'stroke', 'startArrow', 'endArrow'],
  path: [...COMMON_PROPS, 'fill', 'stroke'],
  custom: [...COMMON_PROPS, 'fill', 'stroke', 'data'],
  group: COMMON_PROPS,
  maskGroup: COMMON_PROPS,
  frame: [...COMMON_PROPS, 'fill', 'stroke'],
};

function freshId(document: DocumentV2, ids: IdSource): string | null {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    const id = ids();
    if (
      isValidId(id) &&
      !document.pages.some((page) => page.id === id) &&
      !Object.hasOwn(document.nodes, id)
    ) {
      return id;
    }
  }
  return null;
}

function uniqueIds(ids: unknown): readonly string[] | null {
  if (!Array.isArray(ids)) return null;
  const seen = new Set<string>();
  for (const id of ids as unknown[]) {
    if (typeof id !== 'string' || seen.has(id)) return null;
    seen.add(id);
  }
  return [...seen];
}

function nodeOf(document: DocumentV2, id: unknown): NodeV2 | undefined {
  return typeof id === 'string' && Object.hasOwn(document.nodes, id)
    ? document.nodes[id]
    : undefined;
}

function isIndex(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function inserted<T>(list: readonly T[], index: number, items: readonly T[]): T[] {
  return [...list.slice(0, index), ...items, ...list.slice(index)];
}

/** Clip levels a new child of `owner` sits at. */
function childClipDepth(tree: TreeView, owner: string): number {
  const node = tree.node(owner);
  if (!isContainer(node)) return 0;
  return clipDepth(tree, owner) + (node.type === 'frame' || node.type === 'maskGroup' ? 1 : 0);
}

/**
 * The structural rules checked after a command's document is built, in the section 4.3.1 table
 * order: every touched mask group keeps a path as its first child, then the clip depth of the
 * subtrees whose ancestry changed.
 */
function structural(
  document: DocumentV2,
  touched: Iterable<string>,
  clipRoots: readonly string[],
): Failure | null {
  for (const id of touched) {
    const node = nodeOf(document, id);
    if (node?.type !== 'maskGroup') continue;
    if (document.nodes[node.children[0]!]?.type !== 'path') {
      return fail('editor.invalid-mask-source', nodePath(id, '/children/0'));
    }
  }
  const deep = clipDepthViolation(documentTree(document), clipRoots);
  return deep === null ? null : fail('editor.clip-depth', nodePath(deep, '/parent'));
}

function success(
  document: DocumentV2 | Failure,
  draft: Draft,
  created: readonly string[],
  clipRoots: readonly string[] = [],
): EditResult {
  if ('ok' in document) return document;
  const rejected = structural(document, draft.touched, clipRoots);
  if (rejected !== null) return rejected;
  return { ok: true, document, touched: [...draft.touched], created };
}

/**
 * Restores the descendants of container `id` to their state in `base` when its subtree there has
 * the same members, and returns the container's frame in `base`; null leaves the draft as is.
 */
function restoreSubtree(draft: Draft, base: DocumentV2, id: string): Frame | null {
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
  document: DocumentV2,
  command: DocumentCommand,
  context: EditContext,
): EditResult {
  const custom = context.custom ?? NO_CUSTOM;
  const refit = context.refit ?? true;
  const finish = (draft: Draft) => draft.finish((node) => custom.check(node), { refit });
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
      const next: NodeV2[] = [];
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
      const draft = new Draft(document);
      for (const child of page.children) for (const id of subtree(tree, child)) draft.remove(id);
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
  base: DocumentV2,
  current: DocumentV2,
  touched: Iterable<string>,
  custom: CustomRules = NO_CUSTOM,
): EditResult {
  const draft = new Draft(current);
  draft.adopt(touched);
  const document = draft.finish((node) => custom.check(node), { refit: true, placementBase: base });
  if ('ok' in document) return document;
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
  document: DocumentV2,
  base: DocumentV2,
  edit: GestureEdit,
  custom: CustomRules = NO_CUSTOM,
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
    draft.finish((node) => custom.check(node), { refit: false }),
    draft,
    [],
  );
}

function isPoint(value: unknown): value is PagePoint {
  const point = value as PagePoint | null;
  return (
    typeof point === 'object' &&
    point !== null &&
    typeof point.x === 'number' &&
    Number.isFinite(point.x) &&
    typeof point.y === 'number' &&
    Number.isFinite(point.y)
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
  document: DocumentV2,
  command: CreateCommand,
  context: EditContext,
  custom: CustomRules,
  finish: (draft: Draft) => DocumentV2 | Failure,
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
  const id = freshId(document, context.ids);
  if (id === null) return fail('editor.duplicate-id');

  // Into the parent's local space; on a page nothing changes.
  let placed: NodeV2 = { ...result.node, id, parent };
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
}

/** `groupNodes` (section 4.3). */
function group(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'groupNodes' }>,
  context: EditContext,
  finish: (draft: Draft) => DocumentV2 | Failure,
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
function placeholderId(document: DocumentV2): string {
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
  document: DocumentV2,
  kind: 'group' | 'maskGroup',
  ids: readonly string[],
  owner: string,
  id: string,
  finish: (draft: Draft) => DocumentV2 | Failure,
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
  const container: NodeV2 = {
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
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'moveNodes' }>,
  finish: (draft: Draft) => DocumentV2 | Failure,
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
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'rotateNodes' }>,
  context: EditContext,
  finish: (draft: Draft) => DocumentV2 | Failure,
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

// Arrange commands (MVP M2 contract, section 4.3). They act on nodes of the active page at any
// depth; a listed descendant of a listed node is ignored (the M1 selection rule). Boxes are the
// page-aligned bounds of the nodes' rotated frames (`boundsOf`), and each node moves by a page
// vector turned into its parent space, so nodes of different parents mix freely. A command that
// changes nothing returns the document itself, which the editor records as no step.

type Finish = (draft: Draft) => DocumentV2 | Failure;
type Arranged = Readonly<{ tree: TreeView; roots: readonly string[] }>;

const EDGES: readonly AlignEdge[] = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'];
const OPS: readonly ReorderOp[] = ['forward', 'backward', 'front', 'back'];

/**
 * The shared checks of the arrange commands in the section 4.4 order: `ids` (a list of distinct
 * strings, not empty) at `/ids`, then the command's own fields (`fields`), then the nodes, which
 * must be on the active page. Returns the listed roots in listed order.
 */
function arranged(
  document: DocumentV2,
  rawIds: unknown,
  context: EditContext,
  fields: () => Failure | null,
): Arranged | Failure {
  const ids = uniqueIds(rawIds);
  if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
  const shape = fields();
  if (shape !== null) return shape;
  const tree = documentTree(document);
  if (
    ids.some((id) => nodeOf(document, id) === undefined || pageOf(tree, id) !== context.activePage)
  ) {
    return fail('editor.unknown-node');
  }
  const listed = new Set(ids);
  return { tree, roots: ids.filter((id) => !ancestors(tree, id).some((n) => listed.has(n.id))) };
}

/** The frame of `node` moved by the page vector `(dx, dy)` turned into its parent space. */
function translated(tree: TreeView, node: NodeV2, dx: number, dy: number): Frame {
  const d = rotate(-spaceOf(tree, node.parent).rotation, dx, dy);
  return { ...node.frame, x: node.frame.x + d.x, y: node.frame.y + d.y };
}

/** Sets `frame` on `node` when its position differs; true when it did. */
function place(draft: Draft, node: NodeV2, frame: Frame): boolean {
  if (frame.x === node.frame.x && frame.y === node.frame.y) return false;
  draft.set({ ...node, frame });
  return true;
}

/** Each node's position in the document pre-order of `page`. */
function preorder(document: DocumentV2, tree: TreeView, page: string): Map<string, number> {
  const roots = document.pages.find((entry) => entry.id === page)?.children ?? [];
  return new Map(
    roots.flatMap((child) => subtree(tree, child)).map((id, position) => [id, position] as const),
  );
}

function unchangedResult(document: DocumentV2): EditResult {
  return { ok: true, document, touched: [], created: [] };
}

/**
 * `alignNodes`: the target is the union of the nodes' boxes, or for one node the box of its
 * nearest frame ancestor (none: no change). A page-root node with rotation 0 sets `x` (or `y`)
 * exactly to the target's edge, centre minus half its size, or far edge minus its size; any
 * other node moves by the difference of its box's value from the target's.
 */
function alignNodes(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'alignNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const edge = command.edge;
  const checked = arranged(document, command.ids, context, () =>
    EDGES.includes(edge) ? null : fail('editor.invalid-command', '/edge'),
  );
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  let target: Frame | null;
  if (roots.length === 1) {
    const frame = ancestors(tree, roots[0]!).find((node) => node.type === 'frame');
    target = frame === undefined ? null : boundsOf(document, [frame.id]);
  } else {
    target = boundsOf(document, roots);
  }
  if (target === null) return unchangedResult(document);
  const horizontal = edge === 'left' || edge === 'hcenter' || edge === 'right';
  // The fraction of the box the edge sits at: 0 the low edge, 0.5 the centre, 1 the high edge.
  const at =
    edge === 'left' || edge === 'top' ? 0 : edge === 'hcenter' || edge === 'vcenter' ? 0.5 : 1;
  const [low, size] = horizontal ? [target.x, target.width] : [target.y, target.height];
  const value = (origin: number, extent: number) =>
    at === 0 ? origin : at === 0.5 ? origin + extent / 2 : origin + extent;
  const goal = value(low, size);
  const draft = new Draft(document);
  for (const id of roots) {
    const node = document.nodes[id]!;
    if (tree.page(node.parent) !== undefined && node.rotation === 0) {
      const own = horizontal ? node.frame.width : node.frame.height;
      const exact = at === 0 ? low : at === 0.5 ? low + size / 2 - own / 2 : low + size - own;
      place(draft, node, horizontal ? { ...node.frame, x: exact } : { ...node.frame, y: exact });
      continue;
    }
    const box = boundsOf(document, [id])!;
    const delta = horizontal ? goal - value(box.x, box.width) : goal - value(box.y, box.height);
    place(draft, node, translated(tree, node, horizontal ? delta : 0, horizontal ? 0 : delta));
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * `distributeNodes`: at least 3 nodes. They sort by box centre on the axis, ties by document
 * pre-order; the first and last stay; with span `S = last.max − first.min` and
 * `gap = (S − Σ sizes) / (n − 1)` (sizes summed in sorted order, `gap` possibly negative), each
 * next box's min is the previous box's new max plus `gap`.
 */
function distributeNodes(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'distributeNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const axis = command.axis;
  const checked = arranged(document, command.ids, context, () =>
    axis === 'horizontal' || axis === 'vertical' ? null : fail('editor.invalid-command', '/axis'),
  );
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  if (roots.length < 3) return fail('editor.too-few-nodes');
  const order = preorder(document, tree, context.activePage);
  const horizontal = axis === 'horizontal';
  const entries = roots
    .map((id) => {
      const box = boundsOf(document, [id])!;
      const [min, size] = horizontal ? [box.x, box.width] : [box.y, box.height];
      return { id, min, size, centre: min + size / 2, order: order.get(id)! };
    })
    .sort((a, b) => a.centre - b.centre || a.order - b.order);
  let total = 0;
  for (const entry of entries) total += entry.size;
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const span = last.min + last.size - first.min;
  const gap = (span - total) / (entries.length - 1);
  const draft = new Draft(document);
  let previous = first.min + first.size;
  for (const entry of entries.slice(1, -1)) {
    const min = previous + gap;
    const delta = min - entry.min;
    const node = document.nodes[entry.id]!;
    place(draft, node, translated(tree, node, horizontal ? delta : 0, horizontal ? 0 : delta));
    previous = min + entry.size;
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * The children of one parent after `op` on the `listed` ones: `front` and `back` move them to
 * the top or bottom in their relative order; `forward` moves each maximal run of listed children
 * above the next unlisted sibling above it, `backward` below the next one below it, so runs never
 * pass each other. The last child is on top.
 */
function reordered(children: readonly string[], listed: ReadonlySet<string>, op: ReorderOp) {
  const ins = children.filter((id) => listed.has(id));
  const outs = children.filter((id) => !listed.has(id));
  if (op === 'front') return [...outs, ...ins];
  if (op === 'back') return [...ins, ...outs];
  // Tokens bottom to top: each maximal run of listed children, and each unlisted child alone.
  const tokens: { run: boolean; ids: string[] }[] = [];
  for (const id of children) {
    const previous = tokens[tokens.length - 1];
    if (listed.has(id) && previous?.run === true) previous.ids.push(id);
    else tokens.push({ run: listed.has(id), ids: [id] });
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    // Forward: a run trades places with the unlisted child above it; backward: an unlisted
    // child trades places with the run above it (the run moves below it).
    const swap = next !== undefined && (op === 'forward' ? token.run : next.run);
    if (swap) {
      out.push(...next.ids, ...token.ids);
      i += 1;
    } else {
      out.push(...token.ids);
    }
  }
  return out;
}

/**
 * `reorderNodes`: within each node's own parent, several parents independently. A result that
 * leaves a mask group with a non-path first child fails with `editor.invalid-mask-source`.
 */
function reorderNodes(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'reorderNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const op = command.op;
  const checked = arranged(document, command.ids, context, () =>
    OPS.includes(op) ? null : fail('editor.invalid-command', '/op'),
  );
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  const byParent = new Map<string, Set<string>>();
  for (const id of roots) {
    const parent = document.nodes[id]!.parent;
    const set = byParent.get(parent) ?? new Set<string>();
    set.add(id);
    byParent.set(parent, set);
  }
  const draft = new Draft(document);
  for (const [parent, listed] of byParent) {
    const children = childrenOf(tree, parent);
    const next = reordered(children, listed, op);
    if (next.every((id, i) => id === children[i])) continue;
    draft.setChildren(parent, next);
    // The moved nodes are listed as touched, as for a reorder by `moveNodes`.
    next.forEach((id, i) => {
      if (id !== children[i]) draft.setChecked(draft.node(id)!, true);
    });
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * `nudgeNodes`: each node moves by the page vector `(dx, dy)` turned into its parent space; a
 * page-root node sets `x + dx` and `y + dy` exactly.
 */
function nudgeNodes(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'nudgeNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { dx, dy } = command as { dx: unknown; dy: unknown };
  const checked = arranged(document, command.ids, context, () => {
    if (typeof dx !== 'number' || !Number.isFinite(dx))
      return fail('editor.invalid-command', '/dx');
    if (typeof dy !== 'number' || !Number.isFinite(dy))
      return fail('editor.invalid-command', '/dy');
    return null;
  });
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  const draft = new Draft(document);
  for (const id of roots) {
    const node = document.nodes[id]!;
    place(draft, node, translated(tree, node, dx as number, dy as number));
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * `duplicateNodes` (section 4.3, S8): every check runs on a build with placeholder IDs first, so
 * a failed command draws no ID; then IDs are drawn root by root in the originals' paint order,
 * each subtree in pre-order (a container before its children, in `children` order). Each copy
 * goes into its original's parent directly above the topmost original of that parent, the
 * copies of one parent in their originals' relative order, and moves by the page `offset`. The
 * result's `created` is the copies' root IDs in the result's paint order.
 */
function duplicateNodes(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'duplicateNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const offset: unknown = command.offset;
  const checked = arranged(document, command.ids, context, () =>
    offset === undefined || isPoint(offset) ? null : fail('editor.invalid-command', '/offset'),
  );
  if ('ok' in checked) return checked;
  const { tree } = checked;
  const order = preorder(document, tree, context.activePage);
  const roots = [...checked.roots].sort((a, b) => order.get(a)! - order.get(b)!);
  const originals = roots.flatMap((root) => subtree(tree, root));
  const move = (offset as PagePoint | undefined) ?? { x: 0, y: 0 };
  // Placeholders that no page or node has, in the order the real IDs are drawn.
  const placeholders: string[] = [];
  for (let n = 1; placeholders.length < originals.length; n += 1) {
    const id = `${PENDING_ID}-${n}`;
    if (!document.pages.some((page) => page.id === id) && !Object.hasOwn(document.nodes, id)) {
      placeholders.push(id);
    }
  }
  const build = (ids: readonly string[]) =>
    buildDuplicate(document, tree, context.activePage, roots, originals, ids, move, finish);
  const trial = build(placeholders);
  if (!trial.ok) {
    // A failure in a copy is reported at its original.
    const path = trial.path;
    for (let i = 0; path !== undefined && i < placeholders.length; i += 1) {
      const prefix = nodePath(placeholders[i]!);
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        return fail(trial.code, nodePath(originals[i]!) + path.slice(prefix.length));
      }
    }
    return trial;
  }
  const drawn: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < originals.length; i += 1) {
    let id: string | null = null;
    for (let attempt = 0; attempt < ID_ATTEMPTS && id === null; attempt += 1) {
      const next = context.ids();
      if (
        isValidId(next) &&
        !seen.has(next) &&
        !document.pages.some((page) => page.id === next) &&
        !Object.hasOwn(document.nodes, next)
      ) {
        id = next;
      }
    }
    if (id === null) return fail('editor.duplicate-id');
    seen.add(id);
    drawn.push(id);
  }
  return build(drawn);
}

/** The duplicate of `roots` with `ids[i]` for `originals[i]` (their subtrees in pre-order). */
function buildDuplicate(
  document: DocumentV2,
  tree: TreeView,
  page: string,
  roots: readonly string[],
  originals: readonly string[],
  ids: readonly string[],
  offset: PagePoint,
  finish: Finish,
): EditResult {
  const copyOf = new Map(originals.map((id, i) => [id, ids[i]!] as const));
  const rootSet = new Set(roots);
  const draft = new Draft(document);
  for (const id of originals) {
    const node = document.nodes[id]!;
    const copy: Record<string, unknown> = {
      ...node,
      id: copyOf.get(id)!,
      parent: rootSet.has(id) ? node.parent : copyOf.get(node.parent)!,
    };
    if (isContainer(node)) copy.children = node.children.map((child) => copyOf.get(child)!);
    if (rootSet.has(id)) copy.frame = translated(tree, node, offset.x, offset.y);
    draft.set(copy as NodeV2);
  }
  const parents = [...new Set(roots.map((id) => document.nodes[id]!.parent))];
  for (const parent of parents) {
    const siblings = childrenOf(tree, parent);
    const listed = siblings.filter((id) => rootSet.has(id));
    const top = siblings.indexOf(listed[listed.length - 1]!) + 1;
    draft.setChildren(
      parent,
      inserted(
        siblings,
        top,
        listed.map((id) => copyOf.get(id)!),
      ),
    );
  }
  const copies = roots.map((id) => copyOf.get(id)!);
  const deep = treeDepthViolation(draft, copies);
  if (deep !== null) return fail('document.invalid-field', nodePath(deep, '/parent'));
  const result = success(finish(draft), draft, [], copies);
  if (!result.ok) return result;
  // The copies' roots in the result's paint order.
  const placed = preorder(result.document, documentTree(result.document), page);
  return { ...result, created: [...copies].sort((a, b) => placed.get(a)! - placed.get(b)!) };
}
