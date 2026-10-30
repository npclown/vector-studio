import {
  isValidId,
  scanJson,
  serializeDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV6,
  type InstanceNodeV5,
  type NodeV6,
  type SymbolNodeV6,
  type ValidateNodeOptions,
} from '@vector-studio/model';
import { arranged, preorder, type Finish } from './arrange.js';
import { Draft, fail, type Failure } from './draft.js';
import {
  drawIds,
  isPoint,
  placeholderIds,
  success,
  type CustomRules,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import {
  ExpansionCache,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_NODES_TOTAL,
  sceneCount,
  type Expansion,
} from './expansion.js';
import { deepFreeze } from './freeze.js';
import { remappedOverrides } from './instance-text.js';
import { boundsOfPoints, corners, IDENTITY, relocate } from './geometry.js';
import {
  childrenOf,
  documentTree,
  isContainer,
  isFrameLike,
  nodePath,
  pageInstances,
  pageOf,
  spaceOf,
  subtree,
  treeDepthViolation,
  type TreeView,
} from './tree.js';
import type { DocumentCommand } from './types.js';

// The clipboard fragment (MVP M2 contract, section 6; MVP M7 contract, section 6): `copy`
// serializes subtrees as marked text, `paste` parses it with the model's JSON and node rules plus
// the fragment rules and inserts the subtrees with fresh IDs (section 4.3, S8). Fragment version
// 2 also carries the source of every copied instance whose source was not copied, so that a
// paste can link the instance to it or paste it detached (M7-Q9 (a)). The in-memory clipboard
// and its generation are editor session state; this module only reads and writes text.

/** The first line of every fragment text. */
export const FRAGMENT_MARKER = 'vector-studio/fragment';
/** The fragment version `copy` writes (M7 contract, section 6). */
export const FRAGMENT_VERSION = 2;
const FRAGMENT_KEYS_V1: readonly string[] = ['fragmentVersion', 'schemaVersion', 'roots', 'nodes'];
const FRAGMENT_KEYS_V2: readonly string[] = [...FRAGMENT_KEYS_V1, 'sources', 'sourceNodes'];
const START = { horizontal: 'start', vertical: 'start' } as const;

export type Copied = Readonly<{
  text: string;
  /** The listed roots in document paint order. */
  roots: readonly string[];
  /** The carried source IDs (`sources` of the fragment). */
  sources: readonly string[];
}>;

type Fragment = Readonly<{
  /** In fragment order, which is the copied paint order. */
  roots: readonly string[];
  /** Validated nodes; a root's frame and rotation are in page space. */
  nodes: Readonly<Record<string, NodeV6>>;
  /** The carried source roots (fragment version 2; empty for version 1). */
  sources: readonly string[];
  /**
   * The carried sources' validated subtrees; a carried root keeps its own local placement and
   * names `sourceHolder` as its parent.
   */
  sourceNodes: Readonly<Record<string, NodeV6>>;
  sourceHolder: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSymbolType = (type: unknown): boolean => type === 'symbol' || type === 'instance';

/** A JSON Pointer (RFC 6901) to a path inside the fragment. */
function pointer(path: readonly (string | number)[]): string {
  return path
    .map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/** The fragment path of a field of node `key` in the map `map` (`nodes` or `sourceNodes`). */
const mapPath = (map: string, key: string, field = '') => pointer([map, key]) + field;

/** The model's canonical node objects for `nodes`, in `serializeDocument` key order. */
function canonicalNodes(nodes: ReadonlyMap<string, NodeV6>): unknown {
  const text = serializeDocument({
    schemaVersion: 6,
    id: 'fragment',
    pages: [],
    // fromEntries defines own properties, so a "__proto__" ID stays data.
    nodes: Object.fromEntries(nodes),
  });
  return (JSON.parse(text) as { nodes: unknown }).nodes;
}

/** The nodes of `wanted` in `pages` order, then page-tree pre-order. */
function inPageOrder(document: DocumentV6, tree: TreeView, wanted: ReadonlySet<string>): string[] {
  if (wanted.size === 0) return [];
  return document.pages.flatMap((page) =>
    page.children.flatMap((root) => subtree(tree, root).filter((id) => wanted.has(id))),
  );
}

/**
 * The fragment text of the subtrees of `ids` (nodes of `activePage` at any depth; a listed
 * descendant of a listed node is ignored): the marker line, then compact JSON of
 * `{ fragmentVersion: 2, schemaVersion: 6, roots, nodes, sources, sourceNodes }` with `roots` in
 * document paint order, each root's frame and rotation in page space and its parent `""`, and
 * the nodes and their keys in `serializeDocument` order. `sources` lists, once each and in
 * `pages` order then page-tree pre-order, the source of every copied instance whose source is
 * not among the copied nodes; `sourceNodes` holds their subtrees, each carried root with parent
 * `""` and its own local placement (M7 contract, section 6).
 */
export function copyFragment(
  document: DocumentV6,
  ids: unknown,
  activePage: string,
): Copied | Failure {
  const checked = arranged(document, ids, { activePage }, () => null);
  if ('ok' in checked) return checked;
  const { tree } = checked;
  const order = preorder(document, tree, activePage);
  const roots = [...checked.roots].sort((a, b) => order.get(a)! - order.get(b)!);
  const nodes = new Map<string, NodeV6>();
  const symbols = new Set<string>();
  for (const root of roots) {
    for (const id of subtree(tree, root)) {
      const node = document.nodes[id]!;
      if (node.type === 'instance') symbols.add(node.symbol);
      nodes.set(id, node);
    }
    const node = document.nodes[root]!;
    let placement = { frame: node.frame, rotation: node.rotation };
    if (tree.page(node.parent) === undefined) {
      const space = spaceOf(tree, node.parent);
      placement = relocate(node.frame, node.rotation, space.matrix, space.rotation, IDENTITY, 0);
    }
    nodes.set(root, { ...node, ...placement, parent: '' });
  }
  for (const id of nodes.keys()) symbols.delete(id);
  const sources = inPageOrder(document, tree, symbols);
  const carried = new Map<string, NodeV6>();
  for (const source of sources) {
    for (const id of subtree(tree, source)) carried.set(id, document.nodes[id]!);
    carried.set(source, { ...document.nodes[source]!, parent: '' });
  }
  const body = JSON.stringify({
    fragmentVersion: FRAGMENT_VERSION,
    schemaVersion: 6,
    roots,
    nodes: canonicalNodes(nodes),
    sources,
    sourceNodes: canonicalNodes(carried),
  });
  return { text: `${FRAGMENT_MARKER}\n${body}`, roots, sources };
}

/** An ID that is not a key of `nodes`, for the page that holds the fragment roots in checks. */
function holderId(nodes: Record<string, unknown>): string {
  let id = 'fragment';
  for (let n = 1; Object.hasOwn(nodes, id); n += 1) id = `fragment-${n}`;
  return id;
}

/** One node map of a fragment after its field rules: entries in map order, roots `""`-parented. */
type ReadMap = Readonly<{
  read: readonly (readonly [string, NodeV6])[];
  unparented: ReadonlySet<string>;
  holder: string;
}>;

/** The v5 stroke of each type with one: `shape` is `{ color, width }`, `path` five keys. */
const OLDER_STROKES: Readonly<Record<string, 'shape' | 'path'>> = {
  rectangle: 'shape',
  ellipse: 'shape',
  frame: 'shape',
  symbol: 'shape',
  line: 'path',
  path: 'path',
  custom: 'path',
};
const COLOR_KEYS = ['r', 'g', 'b', 'a'];
const SHAPE_STROKE_KEYS = ['color', 'width'];
const PATH_STROKE_KEYS = ['color', 'width', 'cap', 'join', 'miterLimit'];

/**
 * The model's `readRecord` key rule at `path` (relative to a node): an object with exactly
 * `keys`, a missing key reported before an unknown one; the failing path or null.
 */
function keyFailure(value: unknown, keys: readonly string[], path: string): string | null {
  if (!isRecord(value)) return path;
  for (const key of keys) if (!Object.hasOwn(value, key)) return `${path}${pointer([key])}`;
  for (const key of Object.keys(value)) if (!keys.includes(key)) return `${path}${pointer([key])}`;
  return null;
}

/**
 * A node of a fragment below schema v6 read as a v5 document reads it, then given the v6 stroke
 * of `migrateV5toV6` (M4 contract, sections 2.1 and 7, M4-M1): a rectangle, ellipse, frame or
 * symbol stroke `{ color, width }` gains `cap: 'butt'`, `join: 'round'`, `miterLimit: 4` and
 * `dash: null`, a line, path or custom stroke `dash: null`. The v5 rules read a fill and a
 * stroke colour as a colour only and a stroke with its v5 keys only, so a gradient or a v6 stroke
 * key fails as it does in a v5 document, in the v5 reading order: the fields before the fill,
 * the fill, the stroke, then a line's arrows. Returns the v6 candidate or the failing path
 * relative to the node.
 */
function olderAppearance(
  raw: Record<string, unknown>,
  candidate: Record<string, unknown>,
  options: ValidateNodeOptions,
):
  | Readonly<{ candidate: Record<string, unknown> }>
  | Readonly<{ code: 'document.invalid-field'; path: string }> {
  const shape = OLDER_STROKES[raw.type as string];
  if (shape === undefined) return { candidate };
  // The fields read before the appearance, and the node's own keys, with the appearance and a
  // line's later arrows set to valid values.
  const neutral = { ...candidate };
  for (const key of ['fill', 'stroke']) if (Object.hasOwn(raw, key)) neutral[key] = null;
  if (raw.type === 'line') {
    for (const key of ['startArrow', 'endArrow'])
      if (Object.hasOwn(raw, key)) neutral[key] = 'none';
  }
  const probe = validateNode(neutral, options);
  if (!probe.ok) return probe;
  if (Object.hasOwn(raw, 'fill') && raw.fill !== null) {
    const keys = keyFailure(raw.fill, COLOR_KEYS, '/fill');
    if (keys !== null) return { code: 'document.invalid-field', path: keys };
    const values = validateNode({ ...neutral, fill: raw.fill }, options);
    if (!values.ok) return values;
  }
  if (!Object.hasOwn(raw, 'stroke') || raw.stroke === null) return { candidate };
  const stroke = raw.stroke;
  const keys =
    keyFailure(stroke, shape === 'shape' ? SHAPE_STROKE_KEYS : PATH_STROKE_KEYS, '/stroke') ??
    keyFailure((stroke as Record<string, unknown>).color, COLOR_KEYS, '/stroke/color');
  if (keys !== null) return { code: 'document.invalid-field', path: keys };
  const added =
    shape === 'shape' ? { cap: 'butt', join: 'round', miterLimit: 4, dash: null } : { dash: null };
  return { candidate: { ...candidate, stroke: { ...(stroke as object), ...added } } };
}

/**
 * The model's field rules on each node of `map` (`nodes` or `sourceNodes`), at the fragment's
 * `schemaVersion`, each older node given each later bump's node change (M7 contract, section 6,
 * Versions): `textOverrides: {}` below v5, the v6 strokes below v6 (`olderAppearance`).
 */
function readFields(
  name: string,
  map: Record<string, unknown>,
  version: 1 | 2,
  schemaVersion: number,
): ReadMap | Failure {
  // The empty parent of a fragment root stands for the holder page.
  const holder = holderId(map);
  const read: [string, NodeV6][] = [];
  // Nodes whose parent is written as `""`: only these may be roots, whatever the holder is.
  const unparented = new Set<string>();
  // Below schema v6 a container or instance opacity other than 1 still fails (M4-M2).
  const options: ValidateNodeOptions = { olderInput: schemaVersion < 6 };
  for (const [key, raw] of Object.entries(map)) {
    // Fragment version 1 holds v2 node types only (schema v2 has no `symbol` or `instance`),
    // reported as the model's field rule reports an unknown type, before the node's other fields.
    if (version === 1 && isRecord(raw) && isSymbolType(raw.type)) {
      return fail('document.invalid-field', mapPath(name, key, '/type'));
    }
    // A `text` node is a v4 type: below schema v4 it fails the same way (M6a contract, section 8).
    if (schemaVersion < 4 && isRecord(raw) && raw.type === 'text') {
      return fail('document.invalid-field', mapPath(name, key, '/type'));
    }
    // Below schema v5 an instance has no `textOverrides`, which the v4 to v5 migration adds empty
    // (M6a contract, section 9, M7-T3); a key written there is unknown at that version.
    const older = schemaVersion < 5 && isRecord(raw) && raw.type === 'instance';
    const empty = isRecord(raw) && raw.parent === '';
    if (empty) unparented.add(key);
    let candidate: unknown = empty ? { ...raw, parent: holder } : raw;
    if (older) {
      const rest = { ...(candidate as Record<string, unknown>) };
      delete rest.textOverrides;
      candidate = { ...rest, textOverrides: {} };
      if (Object.hasOwn(raw, 'textOverrides')) {
        // As a v4 document reads it: a missing key comes before the unknown `textOverrides`.
        const probe = validateNode(candidate, options);
        if (!probe.ok) {
          const field = probe.path.slice(1);
          if (field !== '' && !field.includes('/') && !Object.hasOwn(raw, field)) {
            return fail(probe.code, mapPath(name, key, probe.path));
          }
        }
        return fail('document.invalid-field', mapPath(name, key, '/textOverrides'));
      }
    }
    // Below schema v6 the v5 fills and strokes, migrated (M4 contract, section 7, M4-M1).
    if (schemaVersion < 6 && isRecord(raw)) {
      const migrated = olderAppearance(raw, candidate as Record<string, unknown>, options);
      if (!('candidate' in migrated)) {
        return fail(migrated.code, mapPath(name, key, migrated.path));
      }
      candidate = migrated.candidate;
    }
    const result = validateNode(candidate, options);
    if (!result.ok) return fail(result.code, mapPath(name, key, result.path));
    if (result.node.id !== key) return fail('document.invalid-field', mapPath(name, key, '/id'));
    read.push([key, result.node]);
  }
  return { read, unparented, holder };
}

/**
 * The fragment's reference rules on one map: every root written with parent `""`, every other
 * node claimed by exactly one container's `children` and naming it as its parent, every node
 * reachable from a root. With `symbolRoots` (`sourceNodes`), every root must be a `symbol`.
 */
function checkReferences(
  name: string,
  map: Record<string, unknown>,
  { read, unparented }: ReadMap,
  roots: ReadonlySet<string>,
  symbolRoots: boolean,
): Failure | null {
  const owner = new Map<string, string>();
  for (const [key, node] of read) {
    if (!isContainer(node)) continue;
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i]!;
      if (!Object.hasOwn(map, child) || roots.has(child) || owner.has(child)) {
        return fail('editor.invalid-clipboard', mapPath(name, key, `/children/${i}`));
      }
      owner.set(child, key);
    }
  }
  for (const [key, node] of read) {
    if (symbolRoots && roots.has(key) && node.type !== 'symbol') {
      return fail('editor.invalid-clipboard', mapPath(name, key, '/type'));
    }
    const consistent = roots.has(key)
      ? unparented.has(key)
      : !unparented.has(key) && node.parent === owner.get(key);
    if (!consistent) return fail('editor.invalid-clipboard', mapPath(name, key, '/parent'));
  }
  const byId = new Map(read);
  const reached = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    reached.add(id);
    const node = byId.get(id)!;
    if (isContainer(node)) stack.push(...node.children);
  }
  for (const [key] of read) {
    // A node claimed and claiming consistently but never reached is on a cycle.
    if (!reached.has(key)) return fail('editor.invalid-clipboard', mapPath(name, key, '/parent'));
  }
  return null;
}

/**
 * M7-S3 in one map: the first `symbol` or `instance` node, in map order, with a `symbol` ancestor.
 * A text node may be inside one (M6a contract, section 9, M7-T1).
 */
function nestingFailure(name: string, { read }: ReadMap): Failure | null {
  const byId = new Map(read);
  for (const [key, node] of read) {
    if (!isSymbolType(node.type)) continue;
    // The reference rules hold, so every parent chain ends at a root, whose parent is the holder.
    for (let up = byId.get(node.parent); up !== undefined; up = byId.get(up.parent)) {
      if (up.type === 'symbol') {
        return fail('document.invalid-symbol', mapPath(name, key, '/parent'));
      }
    }
  }
  return null;
}

/**
 * Whether `id` is a text node of `map` with the `symbol` node `symbol` among its ancestors. The
 * reference rules hold, so every parent chain ends at a root.
 */
function inSource(map: ReadonlyMap<string, NodeV6>, id: string, symbol: string): boolean {
  const node = map.get(id);
  if (node?.type !== 'text') return false;
  for (let up = map.get(node.parent); up !== undefined; up = map.get(up.parent)) {
    if (up.id === symbol) return up.type === 'symbol';
  }
  return false;
}

/** The model's tree rules on one map, on a holder page holding `roots` (paths into `name`). */
function treeRules(
  name: string,
  { read, holder }: ReadMap,
  roots: readonly string[],
): Readonly<{ nodes: Readonly<Record<string, NodeV6>> }> | Failure {
  const tree = validateFragmentTree({
    schemaVersion: 6,
    id: holder,
    pages: [{ id: holder, name: '', children: [...roots] }],
    nodes: Object.fromEntries(read),
  });
  if (tree.ok) return { nodes: tree.nodes };
  const path = tree.path.startsWith('/nodes/') ? `/${name}${tree.path.slice(6)}` : tree.path;
  return fail(tree.code, path);
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Parses fragment text in the order of the M7 contract, section 6 (extending M2 section 6): the
 * marker line (text without it is `editor.unsupported-clipboard`; a marker not followed by a
 * line feed is `editor.invalid-clipboard`), the model's JSON rules, the top-level keys (six for
 * fragment version 2, else four), `fragmentVersion` (1 or 2), `roots` (a non-empty array of
 * distinct IDs, each a key of `nodes`) and `nodes` (an object), then for version 2 `sources`
 * (distinct IDs, each a key of `sourceNodes` and none of `nodes`) and `sourceNodes` (an object),
 * then `schemaVersion` (2 for version 1, 3 to 6 for version 2), each node's model field rules
 * in `nodes` then `sourceNodes` (a `text` node below v4 failing at its type; an instance below
 * v5 read with `textOverrides: {}` added, a written one failing at that key; a fill or stroke
 * below v6 read with the v5 rules and its stroke migrated, M4-M1), the reference
 * rules of each map (every carried root a `symbol`), M7-S3 nesting in both maps, every
 * instance in `nodes` naming a copied or carried `symbol`, the model's tree rules
 * (`validateFragmentTree`) on two holder documents, `nodes` then `sourceNodes`, then each custom
 * node's extension check in ID order, `nodes` then `sourceNodes`. Paths are into the fragment
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
      finding.kind === 'duplicate-key' &&
      finding.path.length === 2 &&
      (finding.path[0] === 'nodes' || finding.path[0] === 'sourceNodes');
    return fail(
      nodeKey ? 'document.duplicate-id' : 'document.invalid-field',
      pointer(finding.path),
    );
  }
  if (!isRecord(value)) return fail('editor.invalid-clipboard', '');
  const keys = value.fragmentVersion === 2 ? FRAGMENT_KEYS_V2 : FRAGMENT_KEYS_V1;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return fail('editor.invalid-clipboard', pointer([key]));
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return fail('editor.invalid-clipboard', pointer([key]));
  }
  // The fragment's own shape first, roots' and sources' references included, then the version.
  const version = value.fragmentVersion;
  if (version !== 1 && version !== 2) {
    return fail('editor.invalid-clipboard', '/fragmentVersion');
  }
  const { roots, nodes } = value;
  if (!Array.isArray(roots) || roots.length === 0) {
    return fail('editor.invalid-clipboard', '/roots');
  }
  if (!isRecord(nodes)) return fail('editor.invalid-clipboard', '/nodes');
  const rootSet = new Set<string>();
  for (let i = 0; i < roots.length; i += 1) {
    const root: unknown = roots[i];
    if (!isValidId(root) || rootSet.has(root) || !Object.hasOwn(nodes, root)) {
      return fail('editor.invalid-clipboard', `/roots/${i}`);
    }
    rootSet.add(root);
  }
  const sourceSet = new Set<string>();
  let sourceNodes: Record<string, unknown> = {};
  if (version === 2) {
    const { sources } = value;
    const carried = value.sourceNodes;
    if (!Array.isArray(sources)) return fail('editor.invalid-clipboard', '/sources');
    for (let i = 0; i < sources.length; i += 1) {
      const source: unknown = sources[i];
      if (
        !isValidId(source) ||
        sourceSet.has(source) ||
        !isRecord(carried) ||
        !Object.hasOwn(carried, source) ||
        Object.hasOwn(nodes, source)
      ) {
        return fail('editor.invalid-clipboard', `/sources/${i}`);
      }
      sourceSet.add(source);
    }
    if (!isRecord(carried)) return fail('editor.invalid-clipboard', '/sourceNodes');
    sourceNodes = carried;
  }
  // Every fragment-shape failure comes before every model code. Fragment version 1 is read at
  // schema v2 only and version 2 at v3 to v6 (section 6, Versions; M6a contract, sections 8 and
  // 9; M4 contract, section 7): v3 and v4 changed only the version, v5 adds an empty
  // `textOverrides` to instances and v6 rewrites the strokes (M4-M1), which `readFields` applies;
  // copy writes version 2 at v6.
  const schemaVersion = value.schemaVersion;
  const supported =
    version === 1
      ? schemaVersion === 2
      : schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6;
  if (!supported) return fail('document.unsupported-version', '/schemaVersion');

  const main = readFields('nodes', nodes, version, schemaVersion as number);
  if ('ok' in main) return main;
  const side = readFields('sourceNodes', sourceNodes, version, schemaVersion as number);
  if ('ok' in side) return side;
  const references =
    checkReferences('nodes', nodes, main, rootSet, false) ??
    checkReferences('sourceNodes', sourceNodes, side, sourceSet, true);
  if (references !== null) return references;
  const nested = nestingFailure('nodes', main) ?? nestingFailure('sourceNodes', side);
  if (nested !== null) return nested;
  // Every instance names a copied symbol or a carried source.
  const byId = new Map(main.read);
  for (const [key, node] of main.read) {
    if (node.type !== 'instance') continue;
    if (byId.get(node.symbol)?.type !== 'symbol' && !sourceSet.has(node.symbol)) {
      return fail('editor.invalid-clipboard', mapPath('nodes', key, '/symbol'));
    }
  }
  // M7-T3: every override key names a text node of the copied or carried source's subtree.
  const sideById = new Map(side.read);
  for (const [key, node] of main.read) {
    if (node.type !== 'instance') continue;
    const copied = byId.get(node.symbol)?.type === 'symbol';
    const map = copied ? byId : sideById;
    for (const name of Object.keys(node.textOverrides)) {
      if (!inSource(map, name, node.symbol)) {
        return fail(
          'document.invalid-symbol',
          mapPath('nodes', key, `/textOverrides/${pointer([name]).slice(1)}`),
        );
      }
    }
  }

  // The model's tree rules, each map on its own holder page, never one merged node map.
  const validated = treeRules('nodes', main, [...rootSet]);
  if ('ok' in validated) return validated;
  const validatedSources = treeRules('sourceNodes', side, [...sourceSet]);
  if ('ok' in validatedSources) return validatedSources;
  const frozen = deepFreeze(validated.nodes);
  const frozenSources = deepFreeze(validatedSources.nodes);
  for (const [name, map] of [
    ['nodes', frozen],
    ['sourceNodes', frozenSources],
  ] as const) {
    for (const key of Object.keys(map).sort(byCodeUnits)) {
      const rejected = custom.check(map[key]!);
      if (rejected !== null) return fail(rejected.code, mapPath(name, key, rejected.path));
    }
  }
  return {
    roots: [...rootSet],
    nodes: frozen,
    sources: [...sourceSet],
    sourceNodes: frozenSources,
    sourceHolder: side.holder,
  };
}

/**
 * The paste target (section 6): the scope, else a single selected frame or symbol (frame-like,
 * M7 contract, section 1.2), else the page.
 */
function pasteTarget(tree: TreeView, context: EditContext): string {
  const { scope, selection = [], activePage } = context;
  if (typeof scope === 'string' && isContainer(tree.node(scope))) {
    if (pageOf(tree, scope) === activePage) return scope;
  }
  const only = selection.length === 1 ? tree.node(selection[0]!) : undefined;
  if (isFrameLike(only) && pageOf(tree, only.id) === activePage) return only.id;
  return activePage;
}

/** The node objects of the subtree of `root` in `nodes`, in pre-order. */
function subtreeOf(nodes: Readonly<Record<string, NodeV6>>, root: string): NodeV6[] {
  const out: NodeV6[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = nodes[stack.pop()!]!;
    out.push(node);
    if (!isContainer(node)) continue;
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
  }
  return out;
}

/**
 * The content of a source for the content match of section 6, rule (2), as canonical text: its
 * size, `fill`, `stroke`, `opacity` (M4-Q18 (a): it reaches every instance under M4-Q15 (a)),
 * children and every descendant; its placement, name, constraints and visibility do not count.
 */
function contentText(nodes: readonly NodeV6[]): string {
  const [root, ...rest] = nodes as [SymbolNodeV6, ...NodeV6[]];
  const normalized: SymbolNodeV6 = {
    ...root,
    name: '',
    parent: '',
    frame: { x: 0, y: 0, width: root.frame.width, height: root.frame.height },
    rotation: 0,
    constraints: START,
    visible: true,
  };
  return JSON.stringify(canonicalNodes(new Map([normalized, ...rest].map((n) => [n.id, n]))));
}

/** How a pasted instance names its source (M7 contract, section 6, M7-Q9 (a)). */
type Resolution =
  | Readonly<{ kind: 'copied' }>
  | Readonly<{ kind: 'linked' }>
  | Readonly<{ kind: 'detached'; source: SymbolNodeV6; expansion: Expansion | null }>;

/** The scene nodes the instances of `page` and of the whole document add (section 4.1). */
function expandedCounts(
  document: DocumentV6,
  page: string,
  cache: ExpansionCache,
): { page: number; total: number } {
  let onPage = 0;
  let total = 0;
  pageInstances(document).forEach((ids, index) => {
    for (const id of ids) {
      const count = cache.count(document, (document.nodes[id] as InstanceNodeV5).symbol);
      total += count;
      if (document.pages[index]!.id === page) onPage += count;
    }
  });
  return { page: onPage, total };
}

/**
 * Each instance of `fragment.nodes`, in fragment order (`order`), resolved against `document`:
 * to the copy of its copied source; else linked to the carried source's ID when `document` has a
 * `symbol` of that ID and either rule (1) holds for that ID (`links`: this editor's own
 * clipboard, same generation, default ID source, and no command has drawn the ID since the
 * copy) or the symbol's content serializes equal to the carried subtree (rule (2)); else
 * detached, with its expansion from the carried subtree (null when invalid, M7-X3). Before any
 * expansion, each detached instance counts the scene nodes it would add as an instance against
 * the caps of section 4.1, on top of the target page's and the document's instances: the first
 * that crosses one fails the paste with `editor.expansion-limit` at its fragment path, and the
 * instances after it are not resolved further.
 */
function resolveInstances(
  document: DocumentV6,
  fragment: Fragment,
  order: readonly string[],
  links: ReadonlySet<string>,
  context: EditContext,
  custom: CustomRules,
): Map<string, Resolution> | Failure {
  const resolved = new Map<string, Resolution>();
  const matches = new Map<string, boolean>();
  const carriedOf = new Map<string, { nodes: NodeV6[]; count: number }>();
  const tree = documentTree(document);
  const check = (n: NodeV6) => custom.check(n);
  let counts: { page: number; total: number } | null = null;
  const detached: string[] = [];
  for (const key of order) {
    const node = fragment.nodes[key]!;
    if (node.type !== 'instance') continue;
    if (Object.hasOwn(fragment.nodes, node.symbol)) {
      resolved.set(key, { kind: 'copied' });
      continue;
    }
    let carried = carriedOf.get(node.symbol);
    if (carried === undefined) {
      const nodes = subtreeOf(fragment.sourceNodes, node.symbol);
      const root = nodes[0] as SymbolNodeV6;
      const count =
        2 +
        (root.fill === null ? 0 : 1) +
        (root.stroke === null ? 0 : 1) +
        sceneCount(nodes.slice(1));
      carried = { nodes, count };
      carriedOf.set(node.symbol, carried);
    }
    if (tree.node(node.symbol)?.type === 'symbol') {
      let match = links.has(node.symbol) || matches.get(node.symbol);
      if (match === undefined) {
        const local = subtree(tree, node.symbol).map((id) => document.nodes[id]!);
        match = contentText(local) === contentText(carried.nodes);
        matches.set(node.symbol, match);
      }
      if (match) {
        resolved.set(key, { kind: 'linked' });
        continue;
      }
    }
    // The caps, before this instance is expanded.
    counts ??= expandedCounts(
      document,
      context.activePage,
      context.expansions ?? new ExpansionCache(check),
    );
    counts.page += carried.count;
    counts.total += carried.count;
    if (counts.page > MAX_EXPANDED_NODES || counts.total > MAX_EXPANDED_NODES_TOTAL) {
      return fail('editor.expansion-limit', mapPath('nodes', key));
    }
    detached.push(key);
  }
  if (detached.length === 0) return resolved;
  // One holder for every detached instance, each under a key no valid ID has (U+0000).
  const holderNodes: Record<string, NodeV6> = Object.fromEntries(
    Object.entries(fragment.sourceNodes),
  );
  detached.forEach((key, i) => {
    holderNodes[`\u0000${i}`] = { ...fragment.nodes[key]!, id: `\u0000${i}` };
  });
  const holder: DocumentV6 = {
    schemaVersion: 6,
    id: fragment.sourceHolder,
    pages: [],
    nodes: holderNodes,
  };
  const cache = new ExpansionCache(check);
  detached.forEach((key, i) => {
    const node = fragment.nodes[key] as InstanceNodeV5;
    const result = cache.expand(holder, `\u0000${i}`);
    resolved.set(key, {
      kind: 'detached',
      source: carriedOf.get(node.symbol)!.nodes[0] as SymbolNodeV6,
      expansion: result?.ok === true ? result.expansion : null,
    });
  });
  return resolved;
}

/**
 * `paste` (section 6): the fragment from `text`, else the in-memory clipboard. Its roots go on
 * top of the target in fragment order, each at its page placement mapped into the target's
 * space, moved first by the page vector that brings the roots' joint page bounds centre to `at`.
 * A copied source becomes a new, independent `symbol` (M7-Q10 (a)); a copied instance refers to
 * the copy of its copied source, else is linked to its carried source or pasted detached
 * (M7-Q9 (a), M7 contract, section 6). Every check, the target's tree and clip depth included,
 * runs on a build with placeholder IDs first, so a failed paste draws no ID (S8); IDs are then
 * drawn root by root in paint order, each subtree in pre-order, a detached instance's expansion
 * right after the instance in the source's pre-order. Failures inside a pasted node are
 * reported at its fragment path (a detached copy's at its carried node in `sourceNodes`).
 */
export function paste(
  document: DocumentV6,
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
  const fragmentTree = documentTree({
    schemaVersion: 6,
    id: '',
    pages: [],
    nodes: fragment.nodes,
  });
  const rootSet = new Set(fragment.roots);
  const originals = fragment.roots.flatMap((root) => subtree(fragmentTree, root));
  // Rule (1) of section 6: this editor's own clipboard text, in the generation it was copied in,
  // for the carried IDs no command has drawn since the copy.
  const own = typeof context.clipboard === 'string' && source === context.clipboard;
  const links = (own ? context.clipboardLinks : undefined) ?? new Set<string>();
  const resolved = resolveInstances(document, fragment, originals, links, context, custom);
  if ('ok' in resolved) return resolved;

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
  const place = (node: NodeV6) => {
    const frame =
      at === undefined ? node.frame : { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
    return onPage
      ? { frame, rotation: node.rotation }
      : relocate(frame, node.rotation, IDENTITY, 0, space.matrix, space.rotation);
  };

  const expansionOf = (id: string): Expansion | null => {
    const how = resolved.get(id);
    return how?.kind === 'detached' ? how.expansion : null;
  };
  // The ID order, as the fragment path a failure inside each copy is reported at: each root in
  // pre-order, a detached instance followed by its expansion in the source's pre-order.
  const slots: string[] = [];
  for (const id of originals) {
    slots.push(mapPath('nodes', id));
    for (const key of expansionOf(id)?.nodes.keys() ?? []) {
      slots.push(mapPath('sourceNodes', key));
    }
  }
  const siblings = childrenOf(tree, target);
  const build = (ids: readonly string[]): EditResult => {
    const copyOf = new Map<string, string>();
    const expandedCopyOf = new Map<string, Map<string, string>>();
    let next = 0;
    for (const id of originals) {
      copyOf.set(id, ids[next++]!);
      const map = new Map<string, string>();
      for (const key of expansionOf(id)?.nodes.keys() ?? []) map.set(key, ids[next++]!);
      expandedCopyOf.set(id, map);
    }
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
      const how = resolved.get(id);
      if (how?.kind === 'copied') {
        // With its source, the copy's overrides name the copies of the source's text nodes; a
        // linked copy keeps its keys, and a detached one takes the overrides in its expansion
        // (M6a contract, section 9, M7-T3).
        const instance = node as InstanceNodeV5;
        copy.symbol = copyOf.get(instance.symbol)!;
        copy.textOverrides = remappedOverrides(instance.textOverrides, copyOf);
      }
      if (how?.kind === 'detached') {
        // A frame as `detachInstances` makes one (section 5.2), from the carried subtree; with
        // an invalid expansion the trial builds it empty, and the paste fails after it.
        const map = expandedCopyOf.get(id)!;
        for (const [key, expanded] of how.expansion?.nodes ?? []) {
          const inner: Record<string, unknown> = {
            ...expanded,
            id: map.get(key)!,
            // The source's direct children name the source; their copies name the frame.
            parent: expanded.parent === how.source.id ? copy.id : map.get(expanded.parent)!,
          };
          if (isContainer(expanded)) {
            inner.children = expanded.children.map((child) => map.get(child)!);
          }
          draft.set(inner as NodeV6);
        }
        delete copy.symbol;
        delete copy.textOverrides;
        Object.assign(copy, {
          type: 'frame',
          // The effective opacity, as `detachInstances` writes it (MVP M4 contract, section 5).
          opacity: node.opacity * how.source.opacity,
          children: (how.expansion?.children ?? []).map((child) => map.get(child)!),
          fill: how.source.fill,
          stroke: how.source.stroke,
        });
      }
      // A root's mapped placement and a detached frame are validated again; the rest is as the
      // fragment checks left it.
      if (root) draft.set({ ...copy, ...place(node) } as NodeV6);
      else if (how?.kind === 'detached') draft.set(copy as NodeV6);
      else draft.setChecked(copy as NodeV6, true);
    }
    const copies = fragment.roots.map((id) => copyOf.get(id)!);
    draft.setChildren(target, [...siblings, ...copies]);
    const deep = treeDepthViolation(draft, copies);
    if (deep !== null) return fail('document.invalid-field', nodePath(deep, '/parent'));
    return success(finish(draft), draft, copies, copies);
  };
  const placeholders = placeholderIds(document, slots.length);
  const trial = build(placeholders);
  if (!trial.ok) return reportAt(trial, placeholders, slots);
  // An invalid expansion of a detached instance (M7-X3) fails after the paste's own checks, as
  // in the source deletion rule (section 5.4), at the instance's fragment path.
  for (const id of originals) {
    const how = resolved.get(id);
    if (how?.kind === 'detached' && how.expansion === null) {
      return fail('editor.invalid-expansion', mapPath('nodes', id));
    }
  }
  const ids = drawIds(document, context.ids, slots.length);
  if (ids === null) return fail('editor.duplicate-id');
  return build(ids);
}

/** A trial failure inside the copy `from[i]` reported at the fragment path `to[i]`. */
function reportAt(failure: Failure, from: readonly string[], to: readonly string[]): Failure {
  const path = failure.path;
  for (let i = 0; path !== undefined && i < from.length; i += 1) {
    const prefix = nodePath(from[i]!);
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return fail(failure.code, to[i]! + path.slice(prefix.length));
    }
  }
  return failure;
}
