import {
  isValidId,
  scanJson,
  serializeDocument,
  validateDocument,
  validateNode,
  type DocumentV2,
  type NodeV2,
} from '@vector-studio/model';
import { arranged, preorder, type Finish } from './arrange.js';
import { Draft, fail, type Failure } from './draft.js';
import {
  drawIds,
  isPoint,
  placeholderIds,
  remapFailure,
  success,
  type CustomRules,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { deepFreeze } from './freeze.js';
import { boundsOfPoints, corners, IDENTITY, relocate } from './geometry.js';
import {
  childrenOf,
  documentTree,
  isContainer,
  nodePath,
  pageOf,
  spaceOf,
  subtree,
  treeDepthViolation,
  type TreeView,
} from './tree.js';
import type { DocumentCommand } from './types.js';

// The clipboard fragment (MVP M2 contract, section 6): `copy` serializes subtrees as marked text,
// `paste` parses it with the model's JSON and node rules plus the fragment rules and inserts the
// subtrees with fresh IDs (section 4.3, S8). The in-memory clipboard itself is editor session
// state; this module only reads and writes text.

/** The first line of every fragment text. */
export const FRAGMENT_MARKER = 'vector-studio/fragment';
const FRAGMENT_KEYS: readonly string[] = ['fragmentVersion', 'schemaVersion', 'roots', 'nodes'];

export type Copied = Readonly<{
  text: string;
  /** The listed roots in document paint order. */
  roots: readonly string[];
}>;

type Fragment = Readonly<{
  /** In fragment order, which is the copied paint order. */
  roots: readonly string[];
  /** Validated nodes; a root's frame and rotation are in page space. */
  nodes: Readonly<Record<string, NodeV2>>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A JSON Pointer (RFC 6901) to a path inside the fragment. */
function pointer(path: readonly (string | number)[]): string {
  return path
    .map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/**
 * The fragment text of the subtrees of `ids` (nodes of `activePage` at any depth; a listed
 * descendant of a listed node is ignored): the marker line, then compact JSON of
 * `{ fragmentVersion: 1, schemaVersion: 2, roots, nodes }` with `roots` in document paint order,
 * each root's frame and rotation in page space and its parent `""`, and the nodes and their keys
 * in `serializeDocument` order.
 */
export function copyFragment(
  document: DocumentV2,
  ids: unknown,
  activePage: string,
): Copied | Failure {
  const checked = arranged(document, ids, { activePage }, () => null);
  if ('ok' in checked) return checked;
  const { tree } = checked;
  const order = preorder(document, tree, activePage);
  const roots = [...checked.roots].sort((a, b) => order.get(a)! - order.get(b)!);
  const nodes = new Map<string, NodeV2>();
  for (const root of roots) {
    for (const id of subtree(tree, root)) nodes.set(id, document.nodes[id]!);
    const node = document.nodes[root]!;
    let placement = { frame: node.frame, rotation: node.rotation };
    if (tree.page(node.parent) === undefined) {
      const space = spaceOf(tree, node.parent);
      placement = relocate(node.frame, node.rotation, space.matrix, space.rotation, IDENTITY, 0);
    }
    nodes.set(root, { ...node, ...placement, parent: '' });
  }
  // The model's canonical node text, re-read so the fragment keeps its key order compactly.
  const canonical = JSON.parse(
    serializeDocument({
      schemaVersion: 2,
      id: 'fragment',
      pages: [],
      // fromEntries defines own properties, so a "__proto__" ID stays data.
      nodes: Object.fromEntries(nodes),
    }),
  ) as { nodes: unknown };
  const body = JSON.stringify({
    fragmentVersion: 1,
    schemaVersion: 2,
    roots,
    nodes: canonical.nodes,
  });
  return { text: `${FRAGMENT_MARKER}\n${body}`, roots };
}

/** An ID that is not a key of `nodes`, for the page that holds the fragment roots in checks. */
function holderId(nodes: Record<string, unknown>): string {
  let id = 'fragment';
  for (let n = 1; Object.hasOwn(nodes, id); n += 1) id = `fragment-${n}`;
  return id;
}

/**
 * Parses fragment text in this order: the marker line (text without it is
 * `editor.unsupported-clipboard`; a marker not followed by a line feed is
 * `editor.invalid-clipboard`), the model's JSON rules, the fragment's top-level keys,
 * `fragmentVersion`, the shape of `roots` (a non-empty list of IDs) and `nodes` (an object),
 * `schemaVersion`, the roots' references (distinct, each a node), each node's model field
 * rules, the fragment's reference rules (every root written with parent `""`, every other node
 * claimed by exactly one container's `children` and naming it as its parent, every node
 * reachable from a root), the model's tree rules (non-empty groups, a mask group's path source,
 * tree depth), then each custom node's extension check in ID order. Paths are into the fragment
 * JSON.
 */
export function parseFragment(text: string, custom: CustomRules): Fragment | Failure {
  if (!text.startsWith(FRAGMENT_MARKER)) return fail('editor.unsupported-clipboard');
  if (text[FRAGMENT_MARKER.length] !== '\n') return fail('editor.invalid-clipboard', '');
  const body = text.slice(FRAGMENT_MARKER.length + 1);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return fail('document.malformed-json', '');
  }
  // As `parseDocument`: a repeated key would silently drop an entity, and nesting is bounded.
  const finding = scanJson(body);
  if (finding !== null) {
    const nodeKey =
      finding.kind === 'duplicate-key' && finding.path.length === 2 && finding.path[0] === 'nodes';
    return fail(
      nodeKey ? 'document.duplicate-id' : 'document.invalid-field',
      pointer(finding.path),
    );
  }
  if (!isRecord(value)) return fail('editor.invalid-clipboard', '');
  for (const key of FRAGMENT_KEYS) {
    if (!Object.hasOwn(value, key)) return fail('editor.invalid-clipboard', pointer([key]));
  }
  for (const key of Object.keys(value)) {
    if (!FRAGMENT_KEYS.includes(key)) return fail('editor.invalid-clipboard', pointer([key]));
  }
  // The fragment's own shape first, then the schema version, then the roots' references.
  if (value.fragmentVersion !== 1) return fail('editor.invalid-clipboard', '/fragmentVersion');
  const { roots, nodes } = value;
  if (!Array.isArray(roots) || roots.length === 0) {
    return fail('editor.invalid-clipboard', '/roots');
  }
  for (let i = 0; i < roots.length; i += 1) {
    if (!isValidId(roots[i])) return fail('editor.invalid-clipboard', `/roots/${i}`);
  }
  if (!isRecord(nodes)) return fail('editor.invalid-clipboard', '/nodes');
  if (value.schemaVersion !== 2) return fail('document.unsupported-version', '/schemaVersion');
  const rootSet = new Set<string>();
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i] as string;
    if (rootSet.has(root) || !Object.hasOwn(nodes, root)) {
      return fail('editor.invalid-clipboard', `/roots/${i}`);
    }
    rootSet.add(root);
  }

  // The model's field rules; the empty parent of a fragment root stands for the holder page.
  const holder = holderId(nodes);
  const read: [string, NodeV2][] = [];
  // Nodes whose parent is written as `""`: only these may be roots, whatever the holder is.
  const unparented = new Set<string>();
  for (const [key, raw] of Object.entries(nodes)) {
    const empty = isRecord(raw) && raw.parent === '';
    if (empty) unparented.add(key);
    const candidate = empty ? { ...raw, parent: holder } : raw;
    const result = validateNode(candidate);
    if (!result.ok) return fail(result.code, nodePath(key, result.path));
    if (result.node.id !== key) return fail('document.invalid-field', nodePath(key, '/id'));
    read.push([key, result.node]);
  }

  // The fragment's reference rules.
  const owner = new Map<string, string>();
  for (const [key, node] of read) {
    if (!isContainer(node)) continue;
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i]!;
      if (!Object.hasOwn(nodes, child) || rootSet.has(child) || owner.has(child)) {
        return fail('editor.invalid-clipboard', nodePath(key, `/children/${i}`));
      }
      owner.set(child, key);
    }
  }
  for (const [key, node] of read) {
    const consistent = rootSet.has(key)
      ? unparented.has(key)
      : !unparented.has(key) && node.parent === owner.get(key);
    if (!consistent) return fail('editor.invalid-clipboard', nodePath(key, '/parent'));
  }
  const byId = new Map(read);
  const reached = new Set<string>();
  const stack = [...rootSet];
  while (stack.length > 0) {
    const id = stack.pop()!;
    reached.add(id);
    const node = byId.get(id)!;
    if (isContainer(node)) stack.push(...node.children);
  }
  for (const [key] of read) {
    // A node claimed and claiming consistently but never reached is on a cycle.
    if (!reached.has(key)) return fail('editor.invalid-clipboard', nodePath(key, '/parent'));
  }

  // The model's tree rules, with the roots on a holder page.
  const tree = validateDocument({
    schemaVersion: 2,
    id: holder,
    pages: [{ id: holder, name: '', children: [...rootSet] }],
    nodes: Object.fromEntries(read),
  });
  if (!tree.ok) return fail(tree.code, tree.path);
  const validated = deepFreeze(tree.document.nodes);
  for (const key of Object.keys(validated).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const rejected = custom.check(validated[key]!);
    if (rejected !== null) return fail(rejected.code, nodePath(key, rejected.path));
  }
  return { roots: [...rootSet], nodes: validated };
}

/** The paste target (section 6): the scope, else a single selected frame, else the page. */
function pasteTarget(tree: TreeView, context: EditContext): string {
  const { scope, selection = [], activePage } = context;
  if (typeof scope === 'string' && isContainer(tree.node(scope))) {
    if (pageOf(tree, scope) === activePage) return scope;
  }
  const only = selection.length === 1 ? tree.node(selection[0]!) : undefined;
  if (only?.type === 'frame' && pageOf(tree, only.id) === activePage) return only.id;
  return activePage;
}

/**
 * `paste` (section 6): the fragment from `text`, else the in-memory clipboard. Its roots go on
 * top of the target in fragment order, each at its page placement mapped into the target's
 * space, moved first by the page vector that brings the roots' joint page bounds centre to `at`.
 * Every check, the target's tree and clip depth included, runs on a build with placeholder IDs
 * first, so a failed paste draws no ID (S8); IDs are then drawn root by root in paint order,
 * each subtree in pre-order. Failures inside a pasted node are reported at its fragment path.
 */
export function paste(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'paste' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const { text, at } = command as { text?: unknown; at?: unknown };
  if (text !== undefined && typeof text !== 'string') {
    return fail('editor.invalid-command', '/text');
  }
  if (at !== undefined && !isPoint(at)) return fail('editor.invalid-command', '/at');
  const source = text ?? context.clipboard ?? null;
  if (source === null) return fail('editor.empty-clipboard');
  const fragment = parseFragment(source, custom);
  if ('ok' in fragment) return fragment;

  const tree = documentTree(document);
  const target = pasteTarget(tree, context);
  const onPage = tree.page(target) !== undefined;
  const space = spaceOf(tree, target);
  let dx = 0;
  let dy = 0;
  if (at !== undefined) {
    const points = fragment.roots.flatMap((id) => {
      const node = fragment.nodes[id]!;
      return corners(node.frame, node.rotation);
    });
    const bounds = boundsOfPoints(points)!;
    dx = at.x - (bounds.x + bounds.width / 2);
    dy = at.y - (bounds.y + bounds.height / 2);
  }
  const place = (node: NodeV2) => {
    const frame =
      at === undefined ? node.frame : { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
    return onPage
      ? { frame, rotation: node.rotation }
      : relocate(frame, node.rotation, IDENTITY, 0, space.matrix, space.rotation);
  };

  const fragmentTree = documentTree({
    schemaVersion: 2,
    id: '',
    pages: [],
    nodes: fragment.nodes,
  });
  const rootSet = new Set(fragment.roots);
  const originals = fragment.roots.flatMap((root) => subtree(fragmentTree, root));
  const siblings = childrenOf(tree, target);
  const build = (ids: readonly string[]): EditResult => {
    const copyOf = new Map(originals.map((id, i) => [id, ids[i]!] as const));
    const draft = new Draft(document);
    for (const id of originals) {
      const node = fragment.nodes[id]!;
      const root = rootSet.has(id);
      const copy: Record<string, unknown> = {
        ...node,
        id: copyOf.get(id)!,
        parent: root ? target : copyOf.get(node.parent)!,
      };
      if (isContainer(node)) copy.children = node.children.map((child) => copyOf.get(child)!);
      // A root's mapped placement is validated again; the rest is as the fragment checks left it.
      if (root) draft.set({ ...copy, ...place(node) } as NodeV2);
      else draft.setChecked(copy as NodeV2, true);
    }
    const copies = fragment.roots.map((id) => copyOf.get(id)!);
    draft.setChildren(target, [...siblings, ...copies]);
    const deep = treeDepthViolation(draft, copies);
    if (deep !== null) return fail('document.invalid-field', nodePath(deep, '/parent'));
    return success(finish(draft), draft, copies, copies);
  };
  const placeholders = placeholderIds(document, originals.length);
  const trial = build(placeholders);
  if (!trial.ok) return remapFailure(trial, placeholders, originals);
  const ids = drawIds(document, context.ids, originals.length);
  if (ids === null) return fail('editor.duplicate-id');
  return build(ids);
}
