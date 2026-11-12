import {
  MAX_TREE_DEPTH,
  isImagePaint,
  validateImageAsset,
  validateNode,
  type DocumentV8,
  type Fill,
  type ImageAsset,
  type ImageScaleMode,
  type NodeV8,
} from '@vector-studio/model';
import { adoptionOwner } from './adopt.js';
import { Draft, fail, type Failure } from './draft.js';
import {
  freshId,
  isPoint,
  nodeOf,
  success,
  uniqueIds,
  type CustomRules,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { paintFill } from './fills.js';
import { deepFreeze } from './freeze.js';
import { IDENTITY, relocate } from './geometry.js';
import { childrenOf, documentTree, nodePath, pageOf, spaceOf, treeDepth } from './tree.js';
import type { DocumentCommand } from './types.js';

// V-32 contract (docs/plans/viz-v32-image-contract.md), V32-E1, E2: the image commands.
// `insertImages` adds one rectangle per asset with the image as its fill, `setImageFill` sets the
// topmost fill of each fill-capable node to an image and `setImagePaint` changes the mode or scale
// of an image fill. Each is one transaction (one undo step); the image table gains the assets here
// and `Draft.finish` checks the keys and prunes (V32-M4).

type Finish = (draft: Draft) => DocumentV8 | Failure;
type Filled = Extract<NodeV8, { fills: readonly Fill[] }>;

/** The most assets of one `insertImages` (V32-E2). */
const MAX_INSERT = 32;
/** The offset of each further inserted rectangle from the previous one, in page units. */
const INSERT_OFFSET = 20;
const SCALE_MODES: readonly ImageScaleMode[] = ['fill', 'fit', 'stretch', 'tile'];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ReadAsset = Readonly<{ key: string; asset: ImageAsset }>;

/**
 * V32-E1: an `ImageAssetInput` checked with the model's table rules (V32-M1, M2: key, magic
 * bytes, sizes), or `editor.image-invalid` at `path`.
 */
function readAsset(value: unknown, path: string): ReadAsset | Failure {
  if (!isPlainRecord(value)) return fail('editor.image-invalid', path);
  const { key, mimeType, width, height, data } = value;
  const asset = validateImageAsset(key, { mimeType, width, height, data });
  return asset === null ? fail('editor.image-invalid', path) : { key: key as string, asset };
}

/**
 * The table with `reads` added (V32-E1): a key already present with another entry is
 * `editor.image-invalid` at the asset's path; an identical entry is a no-op.
 */
function withAssets(
  table: DocumentV8['images'],
  reads: readonly ReadAsset[],
  paths: readonly string[],
): Readonly<{ images: DocumentV8['images'] }> | Failure {
  // The original table comes back when no key is added, so a repeated command records no step.
  let next: Record<string, ImageAsset> | undefined;
  for (const [index, { key, asset }] of reads.entries()) {
    const held = Object.hasOwn(next ?? table ?? {}, key) ? (next ?? table)![key] : undefined;
    if (held !== undefined && JSON.stringify(held) !== JSON.stringify(asset)) {
      return fail('editor.image-invalid', paths[index]);
    }
    if (held === undefined) {
      next ??= { ...table };
      next[key] = asset;
    }
  }
  return { images: next ?? table };
}

/** The listed nodes of the active page, or a failure (the `ids` rules of the fill commands). */
function listed(
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

function modeOf(value: unknown): ImageScaleMode | undefined | null {
  if (value === undefined) return undefined;
  return (SCALE_MODES as readonly unknown[]).includes(value) ? (value as ImageScaleMode) : null;
}

/** Validates each changed node and commits them, with the image table `table`, in one step. */
function commit(
  document: DocumentV8,
  changed: readonly Filled[],
  table: Readonly<Record<string, ImageAsset>> | undefined,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const checked: NodeV8[] = [];
  for (const node of changed) {
    const result = validateNode(node);
    if (!result.ok) return fail(result.code, nodePath(node.id, result.path));
    const rejected = custom.check(deepFreeze(result.node));
    if (rejected !== null) return fail(rejected.code, nodePath(node.id, rejected.path));
    const before = document.nodes[node.id] as Filled;
    if (JSON.stringify((result.node as Filled).fills) === JSON.stringify(before.fills)) continue;
    checked.push(result.node);
  }
  if (checked.length === 0 && table === document.images) {
    return { ok: true, document, touched: [], created: [] };
  }
  const draft = new Draft(document);
  draft.setImages(table);
  for (const node of checked) draft.setChecked(node, true);
  return success(finish(draft), draft, []);
}

/**
 * `insertImages`: 1 to 32 assets (else `editor.image-invalid` at `/assets`), `names` of the same
 * length when given. One rectangle per asset, appended to the active page, or with
 * `adoptIntoFrames` to the innermost frame under `at`; its frame is the image's natural size,
 * the first centred on `at`, each further one `(20, 20)` beyond the previous. Fill: the image,
 * mode `fill`, scale 1; no stroke; named by `names` or "Image". The new IDs are returned and
 * become the selection (the editor sets it).
 */
export function insertImages(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'insertImages' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const assets: unknown = command.assets;
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_INSERT) {
    return fail('editor.image-invalid', '/assets');
  }
  const names: unknown = command.names;
  if (names !== undefined) {
    if (!Array.isArray(names) || names.length !== assets.length) {
      return fail('editor.image-invalid', '/names');
    }
    if (names.some((name) => typeof name !== 'string'))
      return fail('editor.image-invalid', '/names');
  }
  const at: unknown = command.at;
  if (!isPoint(at)) return fail('editor.invalid-command', '/at');
  const reads: ReadAsset[] = [];
  for (const [index, value] of (assets as unknown[]).entries()) {
    const read = readAsset(value, `/assets/${index}`);
    if ('ok' in read) return read;
    reads.push(read);
  }
  const table = withAssets(
    document.images,
    reads,
    reads.map((_, index) => `/assets/${index}`),
  );
  if ('ok' in table) return table;

  const tree = documentTree(document);
  const parent =
    context.adoptIntoFrames === true
      ? adoptionOwner(document, context.activePage, context.scope ?? null, at)
      : context.activePage;
  const onPage = tree.page(parent) !== undefined;
  const space = onPage ? null : spaceOf(tree, parent);
  const siblings = childrenOf(tree, parent);
  if (!onPage && treeDepth(tree, parent) + 1 > MAX_TREE_DEPTH) {
    return fail('document.invalid-field', '/parent');
  }

  const ids: string[] = [];
  const draft = new Draft(document);
  draft.setImages(table.images);
  for (const [index, { key, asset }] of reads.entries()) {
    let id = freshId(document, context.ids);
    for (let tries = 0; id !== null && ids.includes(id) && tries < 1000; tries += 1) {
      id = freshId(document, context.ids);
    }
    if (id === null || ids.includes(id)) return fail('editor.duplicate-id');
    const offset = INSERT_OFFSET * index;
    const frame = {
      x: at.x + offset - asset.width / 2,
      y: at.y + offset - asset.height / 2,
      width: asset.width,
      height: asset.height,
    };
    const local =
      space === null
        ? { frame, rotation: 0 }
        : relocate(frame, 0, IDENTITY, 0, space.matrix, space.rotation);
    const result = validateNode({
      id,
      parent,
      name: (names as readonly string[] | undefined)?.[index] ?? 'Image',
      frame: local.frame,
      rotation: local.rotation,
      constraints: { horizontal: 'start', vertical: 'start' },
      opacity: 1,
      visible: true,
      effects: [],
      blendMode: 'normal',
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fills: [paintFill({ kind: 'image', image: key, scaleMode: 'fill', scale: 1 })],
      stroke: null,
    });
    if (!result.ok) return fail(result.code, result.path);
    const rejected = custom.check(deepFreeze(result.node));
    if (rejected !== null) return fail(rejected.code, rejected.path);
    draft.setChecked(result.node, true);
    ids.push(id);
  }
  draft.setChildren(parent, [...siblings, ...ids]);
  return success(finish(draft), draft, ids, ids);
}

/**
 * `setImageFill`: the topmost fill's paint of each listed fill-capable node becomes the image
 * (a node without fills gets one fill; visibility, opacity and blend mode of a replaced fill are
 * kept). Nodes without fills are skipped; none qualifying is `editor.image-no-target`. Mode
 * defaults to `fill`, scale to 1.
 */
export function setImageFill(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setImageFill' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = listed(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  const mode = modeOf(command.scaleMode);
  if (mode === null) return fail('editor.invalid-command', '/scaleMode');
  const read = readAsset(command.asset, '/asset');
  if ('ok' in read) return read;
  const table = withAssets(document.images, [read], ['/asset']);
  if ('ok' in table) return table;
  const targets = nodes.filter((node): node is Filled => 'fills' in node);
  if (targets.length === 0) return fail('editor.image-no-target', '/ids');
  const paint = {
    kind: 'image' as const,
    image: read.key,
    scaleMode: mode ?? 'fill',
    scale: 1,
  };
  return commit(
    document,
    targets.map((node) => ({
      ...node,
      fills:
        node.fills.length === 0
          ? [paintFill(paint)]
          : node.fills.map((fill, index) =>
              index === node.fills.length - 1 ? { ...fill, paint } : fill,
            ),
    })),
    table.images,
    custom,
    finish,
  );
}

/**
 * `setImagePaint`: sets the mode and/or scale of the topmost fill of each listed node whose
 * topmost fill is an image paint; none is `editor.image-no-target`. A value out of range fails
 * the model's check at the paint (`/fills/<i>/paint/scale`).
 */
export function setImagePaint(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'setImagePaint' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const nodes = listed(document, command.ids, context);
  if ('ok' in nodes) return nodes;
  const mode = modeOf(command.scaleMode);
  if (mode === null) return fail('editor.invalid-command', '/scaleMode');
  const scale: unknown = command.scale;
  if (mode === undefined && scale === undefined)
    return fail('editor.invalid-command', '/scaleMode');
  const targets = nodes.filter(
    (node): node is Filled =>
      'fills' in node &&
      node.fills.length > 0 &&
      isImagePaint(node.fills[node.fills.length - 1]!.paint),
  );
  if (targets.length === 0) return fail('editor.image-no-target', '/ids');
  return commit(
    document,
    targets.map((node) => ({
      ...node,
      fills: node.fills.map((fill, index) =>
        index === node.fills.length - 1 && isImagePaint(fill.paint)
          ? {
              ...fill,
              paint: {
                ...fill.paint,
                ...(mode === undefined ? {} : { scaleMode: mode }),
                ...(scale === undefined ? {} : { scale: scale as number }),
              },
            }
          : fill,
      ),
    })),
    document.images,
    custom,
    finish,
  );
}
