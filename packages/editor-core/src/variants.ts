import {
  validateDocument,
  validateNode,
  type DocumentV8,
  type Frame,
  type InstanceNodeV8,
  type NodeOverride,
  type NodeV8,
  type SymbolNodeV8,
  type SymbolSetNode,
  type TextOverride,
} from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import {
  inserted,
  nodeOf,
  PENDING_ID,
  freshId,
  success,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { sameRuns } from './expansion.js';
import {
  ancestors,
  childrenOf,
  documentTree,
  nodePath,
  pageOf,
  treeDepthViolation,
} from './tree.js';
import type { DocumentCommand } from './types.js';
import { distinctVariant, valueFromName } from './variant-names.js';
import { visualBounds } from './visual-bounds.js';

// Component variants and instance property overrides (V-37 contract, sections 4.1 and 4.2):
// `combineAsVariants`, `setVariantProperties`, `setInstanceVariant`, `setInstanceOverride` and
// `resetInstanceOverrides`. The set rules a command can break (entering and leaving a set, an
// empty set) are `Draft.finish`'s, so every command shares them.

type Finish = (draft: Draft) => DocumentV8 | Failure;
type Loose = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' } as const;
/** The component set's border colour, #9747FF. */
const SET_BORDER = { r: 0x97 / 255, g: 0x47 / 255, b: 1, a: 1 } as const;
/** The room a new set leaves around its variants (section 4.1). */
const SET_MARGIN = 20;
const OVERRIDE_FIELDS = ['fills', 'stroke', 'opacity', 'visible', 'effects'] as const;

const escaped = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const unchanged = (document: DocumentV8): EditResult => ({
  ok: true,
  document,
  touched: [],
  created: [],
});
const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const byUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The node `id` as a node of the active page, else `editor.unknown-node`. */
function onPage(document: DocumentV8, context: EditContext, id: string): NodeV8 | undefined {
  const node = nodeOf(document, id);
  return node !== undefined && pageOf(documentTree(document), id) === context.activePage
    ? node
    : undefined;
}

/**
 * `combineAsVariants { ids }` (section 4.1): the checks in order are the shape of `ids`
 * (`editor.invalid-command` at `/ids`: a list of at least two distinct strings),
 * `editor.unknown-node` (also a node off the active page), `editor.not-a-symbol`,
 * `editor.not-siblings`, `editor.invalid-variant` (one is in a set already), the wrap checks and
 * `editor.duplicate-id`.
 */
export function combineAsVariants(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'combineAsVariants' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const ids: unknown = command.ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 2 ||
    (ids as unknown[]).some((id) => typeof id !== 'string') ||
    new Set(ids as string[]).size !== ids.length
  ) {
    return fail('editor.invalid-command', '/ids');
  }
  const listed = ids as string[];
  const nodes = listed.map((id) => onPage(document, context, id));
  if (nodes.some((node) => node === undefined)) return fail('editor.unknown-node');
  if (nodes.some((node) => node!.type !== 'symbol')) return fail('editor.not-a-symbol');
  const owner = nodes[0]!.parent;
  if (nodes.some((node) => node!.parent !== owner)) return fail('editor.not-siblings');
  if (document.nodes[owner]?.type === 'symbolSet') return fail('editor.invalid-variant');
  // Every check runs with a placeholder ID first, so a failed command draws no ID.
  let placeholder = PENDING_ID;
  for (
    let n = 1;
    document.pages.some((page) => page.id === placeholder) ||
    Object.hasOwn(document.nodes, placeholder);
    n += 1
  ) {
    placeholder = `${PENDING_ID}-${n}`;
  }
  const trial = buildSet(document, listed, owner, placeholder, finish);
  if (!trial.ok) {
    const prefix = nodePath(placeholder);
    const path = trial.path;
    return path !== undefined && (path === prefix || path.startsWith(`${prefix}/`))
      ? fail(trial.code, path.slice(prefix.length) || undefined)
      : trial;
  }
  const id = freshId(document, context.ids);
  if (id === null) return fail('editor.duplicate-id');
  return buildSet(document, listed, owner, id, finish);
}

function buildSet(
  document: DocumentV8,
  ids: readonly string[],
  owner: string,
  id: string,
  finish: Finish,
): EditResult {
  const siblings = childrenOf(documentTree(document), owner);
  const members = siblings.filter((child) => ids.includes(child));
  const symbols = members.map((member) => document.nodes[member]! as SymbolNodeV8);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const symbol of symbols) {
    const b = visualBounds(document, symbol);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const x = minX - SET_MARGIN;
  const y = minY - SET_MARGIN;
  const set: SymbolSetNode = {
    id,
    name: 'Component set',
    parent: owner,
    frame: {
      x,
      y,
      width: maxX - minX + 2 * SET_MARGIN,
      height: maxY - minY + 2 * SET_MARGIN,
    },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'symbolSet',
    children: members,
    fills: [],
    stroke: {
      color: SET_BORDER,
      width: 1,
      cap: 'butt',
      join: 'miter',
      miterLimit: 4,
      dash: { pattern: [4, 4], phase: 0 },
    },
    effects: [],
    blendMode: 'passThrough',
  };
  const draft = new Draft(document);
  draft.set(set);
  // The symbols keep their page placement; each names its variant from its own name (V37-N1),
  // made distinct in child order (V37-N2).
  const seen = new Set<string>();
  for (const symbol of symbols) {
    const variant = distinctVariant({ 'Property 1': valueFromName(symbol.name) }, seen);
    draft.set({
      ...symbol,
      parent: id,
      frame: { ...symbol.frame, x: symbol.frame.x - x, y: symbol.frame.y - y },
      variant,
    });
  }
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

/**
 * `setVariantProperties { updates }` (section 4.1): the checks in order are the shape
 * (`editor.invalid-command` at `/updates`, an entry's `/id` or `/variant`: a non-empty list of
 * distinct IDs), `editor.unknown-node`, `editor.not-a-symbol`, `editor.invalid-variant` (not in a
 * set), then the model's V37-S2 codes on the whole result.
 */
export function setVariantProperties(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setVariantProperties' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const updates: unknown = command.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return fail('editor.invalid-command', '/updates');
  }
  const seen = new Set<string>();
  for (let i = 0; i < updates.length; i += 1) {
    const entry: unknown = updates[i];
    if (!isObject(entry)) return fail('editor.invalid-command', `/updates/${i}`);
    if (typeof entry.id !== 'string' || seen.has(entry.id)) {
      return fail('editor.invalid-command', `/updates/${i}/id`);
    }
    seen.add(entry.id);
    if (!isObject(entry.variant)) return fail('editor.invalid-command', `/updates/${i}/variant`);
  }
  const entries = updates as { id: string; variant: Record<string, string> }[];
  const nodes = entries.map((entry) => onPage(document, context, entry.id));
  if (nodes.some((node) => node === undefined)) return fail('editor.unknown-node');
  if (nodes.some((node) => node!.type !== 'symbol')) return fail('editor.not-a-symbol');
  if (nodes.some((node) => document.nodes[node!.parent]?.type !== 'symbolSet')) {
    return fail('editor.invalid-variant');
  }
  const draft = new Draft(document);
  entries.forEach((entry, i) => {
    draft.set({ ...(nodes[i] as SymbolNodeV8), variant: entry.variant });
  });
  const finished = finish(draft);
  if ('ok' in finished) return finished;
  const checked = validateDocument(finished);
  if (!checked.ok) return fail(checked.code, checked.path);
  return success(finished, draft, []);
}

/** The path of `id` below `source`: each node's name and its index among same-named siblings. */
function layerPath(
  document: DocumentV8,
  source: string,
  id: string,
): readonly (readonly [string, number])[] | null {
  const path: (readonly [string, number])[] = [];
  let at = id;
  while (at !== source) {
    const node = document.nodes[at];
    const parent = node === undefined ? undefined : document.nodes[node.parent];
    if (node === undefined || parent === undefined || !('children' in parent)) return null;
    const named = parent.children.filter((child) => document.nodes[child]?.name === node.name);
    path.unshift([node.name, named.indexOf(at)]);
    at = parent.id;
  }
  return path;
}

/** The node of the subtree of `root` at `path`, or undefined. */
function nodeAtPath(
  document: DocumentV8,
  root: string,
  path: readonly (readonly [string, number])[],
): NodeV8 | undefined {
  let node = document.nodes[root];
  for (const [name, index] of path) {
    if (node === undefined || !('children' in node)) return undefined;
    const named = node.children.filter((child) => document.nodes[child]?.name === name);
    node = named[index] === undefined ? undefined : document.nodes[named[index]];
  }
  return node;
}

/** Whether `field` of an override applies to `target`, the source itself when `root` (V37-S3). */
function applies(field: string, target: NodeV8, root: boolean): boolean {
  return field === 'fills' || field === 'stroke' ? field in target : !root;
}

/** The value of override field `field` the node has itself. */
const ownValue = (node: NodeV8, field: string): unknown => (node as unknown as Loose)[field];

/**
 * `setInstanceVariant { id, values }` (section 4.1): the checks in order are the shape
 * (`editor.invalid-command` at `/id`, `/values` or `/values/<name>`), `editor.unknown-node`
 * (also off the active page), `editor.not-an-instance`, `editor.invalid-variant` (the source is in
 * no set), `editor.no-such-variant` (a name the set lacks, else no variant matching), then the
 * M7-S5 and expansion checks of the instance as a reparented node. The overrides carry by layer
 * path; a command naming the current variant changes nothing and records no step.
 */
export function setInstanceVariant(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setInstanceVariant' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { id, values } = command as Loose;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (!isObject(values) || Object.keys(values).length === 0) {
    return fail('editor.invalid-command', '/values');
  }
  for (const name of Object.keys(values)) {
    if (typeof values[name] !== 'string') {
      return fail('editor.invalid-command', `/values/${escaped(name)}`);
    }
  }
  const instance = onPage(document, context, id);
  if (instance === undefined) return fail('editor.unknown-node');
  if (instance.type !== 'instance') return fail('editor.not-an-instance');
  const source = document.nodes[instance.symbol];
  const set = source === undefined ? undefined : document.nodes[source.parent];
  if (source?.type !== 'symbol' || set?.type !== 'symbolSet' || source.variant === undefined) {
    return fail('editor.invalid-variant');
  }
  const wanted = values as Record<string, string>;
  const unknown = Object.keys(wanted).find((name) => !Object.hasOwn(source.variant!, name));
  if (unknown !== undefined) return fail('editor.no-such-variant', `/values/${escaped(unknown)}`);
  const variant = { ...source.variant, ...wanted };
  const target = set.children
    .map((child) => document.nodes[child])
    .find(
      (child): child is SymbolNodeV8 =>
        child?.type === 'symbol' && same(child.variant, sortedCopy(variant)),
    );
  if (target === undefined) return fail('editor.no-such-variant', '/values');
  if (target.id === source.id) return unchanged(document);

  const unresized =
    instance.frame.width === source.frame.width && instance.frame.height === source.frame.height;
  const frame: Frame = unresized
    ? { ...instance.frame, width: target.frame.width, height: target.frame.height }
    : instance.frame;
  const carried = carryOverrides(document, instance, source, target);
  const next: Loose = { ...instance, symbol: target.id, frame, textOverrides: carried.text };
  if (carried.props === undefined) delete next.overrides;
  else next.overrides = carried.props;
  const draft = new Draft(document);
  draft.setChecked(next as unknown as NodeV8, true);
  return success(finish(draft), draft, []);
}

const sortedCopy = (variant: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.keys(variant)
      .sort(byUnits)
      .map((key) => [key, variant[key]]),
  );

/**
 * The overrides of `instance` carried from `source` to `target` by layer path (V37-Q3): a key
 * moves to the target's node at the same path and is dropped when there is none; a field the
 * target node cannot take, or that equals its own value, is dropped; a text key moves to a text
 * node only.
 */
function carryOverrides(
  document: DocumentV8,
  instance: InstanceNodeV8,
  source: SymbolNodeV8,
  target: SymbolNodeV8,
): { text: Record<string, TextOverride>; props: Record<string, NodeOverride> | undefined } {
  const mapKey = (key: string) => {
    const path = layerPath(document, source.id, key);
    const node = path === null ? undefined : nodeAtPath(document, target.id, path);
    return node === undefined ? null : { node, root: path!.length === 0 };
  };
  const text: Record<string, TextOverride> = {};
  for (const key of Object.keys(instance.textOverrides).sort(byUnits)) {
    const found = mapKey(key);
    const override = instance.textOverrides[key]!;
    if (found === null || found.node.type !== 'text') continue;
    if (sameRuns(found.node.runs, override.runs)) continue;
    text[found.node.id] = override;
  }
  const merged = new Map<string, Loose>();
  for (const key of Object.keys(instance.overrides ?? {})) {
    const found = mapKey(key);
    if (found === null) continue;
    const kept: Loose = {};
    const own = instance.overrides![key]! as Loose;
    for (const field of OVERRIDE_FIELDS) {
      if (!Object.hasOwn(own, field)) continue;
      if (!applies(field, found.node, found.root)) continue;
      if (same(own[field], ownValue(found.node, field))) continue;
      kept[field] = own[field];
    }
    if (Object.keys(kept).length > 0) merged.set(found.node.id, kept);
  }
  const keys = [...merged.keys()].sort(byUnits);
  return {
    text: Object.fromEntries(
      Object.keys(text)
        .sort(byUnits)
        .map((key) => [key, text[key]!]),
    ),
    props:
      keys.length === 0
        ? undefined
        : Object.fromEntries(keys.map((key) => [key, merged.get(key)!])),
  };
}

/** The instance `id` of the active page whose source subtree holds `node`, or a failure. */
function overridable(
  document: DocumentV8,
  context: EditContext,
  id: string,
  node: string | undefined,
): { instance: InstanceNodeV8; target: NodeV8 | undefined } | Failure {
  const instance = onPage(document, context, id);
  if (instance === undefined) return fail('editor.unknown-node');
  if (instance.type !== 'instance') return fail('editor.not-an-instance');
  if (node === undefined) return { instance, target: undefined };
  const target = nodeOf(document, node);
  const inside =
    target !== undefined &&
    (node === instance.symbol ||
      ancestors(documentTree(document), node).some((up) => up.id === instance.symbol));
  if (!inside) return fail('editor.invalid-override', '/node');
  return { instance, target };
}

/**
 * `setInstanceOverride { id, node, props }` (section 4.2): the checks in order are the shape
 * (`editor.invalid-command` at `/id`, `/node`, `/props` or `/props/<key>`: an unknown or undefined
 * field), `editor.unknown-node` (also off the active page), `editor.not-an-instance`,
 * `editor.invalid-override` (`node` outside the source subtree, at `/node`), then V37-S3's values
 * and applicability (`document.invalid-field` at `/nodes/<id>/overrides/<node>/<field>`) and the
 * expansion. A field equal to the source node's own value removes that field's override; an
 * override left empty is removed.
 */
export function setInstanceOverride(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setInstanceOverride' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { id, node, props } = command as Loose;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (typeof node !== 'string') return fail('editor.invalid-command', '/node');
  if (!isObject(props) || Object.keys(props).length === 0) {
    return fail('editor.invalid-command', '/props');
  }
  for (const key of Object.keys(props)) {
    if (!(OVERRIDE_FIELDS as readonly string[]).includes(key) || props[key] === undefined) {
      return fail('editor.invalid-command', `/props/${escaped(key)}`);
    }
  }
  const found = overridable(document, context, id, node);
  if ('ok' in found) return found;
  const { instance, target } = found;
  const current = instance.overrides ?? {};
  const merged = { ...(Object.hasOwn(current, node) ? current[node] : {}), ...props } as Loose;
  const checked = validateNode({ ...instance, overrides: { ...current, [node]: merged } });
  if (!checked.ok) return fail(checked.code, nodePath(id, checked.path));
  const valid = (checked.node as InstanceNodeV8).overrides![node]! as Loose;
  const root = node === instance.symbol;
  for (const field of OVERRIDE_FIELDS) {
    if (Object.hasOwn(props, field) && !applies(field, target!, root)) {
      return fail('document.invalid-field', nodePath(id, `/overrides/${escaped(node)}/${field}`));
    }
  }
  // A value equal to the source node's own is no override.
  const kept: Loose = {};
  for (const field of OVERRIDE_FIELDS) {
    if (!Object.hasOwn(valid, field)) continue;
    if (!same(valid[field], ownValue(target!, field))) kept[field] = valid[field];
  }
  const rest = Object.keys(current).filter((key) => key !== node);
  const keys = Object.keys(kept).length > 0 ? [...rest, node] : rest;
  const overrides =
    keys.length === 0
      ? undefined
      : Object.fromEntries(
          keys.sort(byUnits).map((key) => [key, key === node ? kept : current[key]!]),
        );
  return writeOverrides(document, instance, instance.textOverrides, overrides, finish);
}

/**
 * `resetInstanceOverrides { id, node? }` (section 4.2): removes the property and text overrides of
 * `node`, or every one. The checks in order are the shape (`editor.invalid-command` at `/id` or
 * `/node`), `editor.unknown-node`, `editor.not-an-instance` and `editor.invalid-override` (`node`
 * outside the source subtree, at `/node`). A reset that removes nothing records no step.
 */
export function resetInstanceOverrides(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'resetInstanceOverrides' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { id, node } = command as Loose;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (node !== undefined && typeof node !== 'string') {
    return fail('editor.invalid-command', '/node');
  }
  const found = overridable(document, context, id, node);
  if ('ok' in found) return found;
  const { instance } = found;
  if (node === undefined) return writeOverrides(document, instance, {}, undefined, finish);
  const without = <T>(record: Readonly<Record<string, T>> | undefined) => {
    const entries = Object.entries(record ?? {}).filter(([key]) => key !== node);
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  };
  return writeOverrides(
    document,
    instance,
    without(instance.textOverrides) ?? {},
    without(instance.overrides),
    finish,
  );
}

/** The instance with new text and property overrides, as one step; unchanged records none. */
function writeOverrides(
  document: DocumentV8,
  instance: InstanceNodeV8,
  textOverrides: InstanceNodeV8['textOverrides'],
  overrides: InstanceNodeV8['overrides'],
  finish: Finish,
): EditResult {
  if (same(textOverrides, instance.textOverrides) && same(overrides, instance.overrides)) {
    return unchanged(document);
  }
  const next: Loose = { ...instance, textOverrides };
  if (overrides === undefined) delete next.overrides;
  else next.overrides = overrides;
  const draft = new Draft(document);
  draft.setChecked(next as unknown as NodeV8, true);
  return success(finish(draft), draft, []);
}
