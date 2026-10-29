import type {
  PathStroke,
  PathStyle,
  PrimitiveGeometry,
  PrimitiveStyle,
  RenderChildOrder,
  RenderNodeSnapshot,
  SceneAffine,
  SceneClip,
  SceneColor,
  SceneDash,
  SceneGradient,
  SceneGradientStop,
  SceneIdentity,
  ScenePaint,
  ScenePathGeometry,
  ScenePathVerb,
  ScenePoint,
  SceneRejectionReason,
  SceneStroke,
} from '@vector-studio/contracts';
import {
  SCENE_MAX_CLIP_DEPTH,
  SCENE_MAX_DASH_ENTRIES,
  SCENE_MAX_GRADIENT_STOPS,
} from '@vector-studio/contracts';
import { hasFiniteSceneArithmetic } from './scene-numeric.js';

/** Port presence, fixed when a mirror is constructed (P3 V3 contract, section a). */
export type PathNodeSupport = 'supported' | 'unsupported';
/**
 * P4 contract, units U1 and U3: which non-null container clips the renderer draws. `rect` draws
 * rect clips (U3) and still reports a mask container as `unsupported-feature` until U4.
 */
export type ClipSupport = 'supported' | 'rect' | 'unsupported';
/**
 * E23 contract, E23-S3: whether the renderer draws gradient paints. Under 'solid' a node with
 * any gradient paint is reported as `unsupported-feature`.
 */
export type PaintSupport = 'solid' | 'gradient';
/**
 * E24 contract, E24-S3: whether the renderer dashes path strokes. Unless 'supported', a node
 * with a non-null dash on a stroke of width > 0 is reported as `unsupported-feature`.
 */
export type DashSupport = 'unsupported' | 'supported';

/**
 * The port-presence facts of a mirror (V3 section a; B2 stroke contract, section 5 and the
 * section 9.1 amendment S4): path nodes at all, fills (`fill !== null`) and strokes with
 * `width > 0`. `clips` (P4 contract, unit U1) says whether the renderer draws a non-null
 * container clip; until it does, such a container is reported as `unsupported-feature`.
 */
export type PathSupport = Readonly<{
  pathNodes: PathNodeSupport;
  pathFills: PathNodeSupport;
  pathStrokes: PathNodeSupport;
  clips: ClipSupport;
  /** E23-S3; absent means 'solid'. */
  paints?: PaintSupport;
  /** E24-S3; absent means 'unsupported'. */
  dashes?: DashSupport;
}>;

const NO_PATH_SUPPORT: PathSupport = Object.freeze({
  pathNodes: 'unsupported',
  pathFills: 'unsupported',
  pathStrokes: 'unsupported',
  clips: 'unsupported',
});

export type ValidatedNode = Readonly<{
  node: RenderNodeSnapshot;
  unsupported: boolean;
}>;

export type ValidatedSnapshotInput = Readonly<{
  identity: SceneIdentity;
  revision: number;
  nodes: readonly ValidatedNode[];
  rootOrder: readonly string[];
}>;

export type ValidatedChangesInput = Readonly<{
  identity: SceneIdentity;
  revision: number;
  baseRevision: number;
  inserted: readonly ValidatedNode[];
  updated: readonly ValidatedNode[];
  removed: readonly string[];
  orders: readonly RenderChildOrder[];
}>;

export function validateSnapshotShape(
  input: unknown,
  pathNodes: PathSupport = NO_PATH_SUPPORT,
): ValidatedSnapshotInput | null {
  if (!hasExactFields(input, ['identity', 'revision', 'nodes', 'rootOrder'])) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const identity = copyIdentity(record.identity);
  const revision = copyRevision(record.revision);
  const nodes = copyArray(record.nodes, (entry) => copyNode(entry, pathNodes));
  const rootOrder = copyArray(record.rootOrder, copyId);
  if (identity === null || revision === null || nodes === null || rootOrder === null) {
    return null;
  }
  return Object.freeze({ identity, revision, nodes, rootOrder });
}

export function validateChangesShape(
  input: unknown,
  pathNodes: PathSupport = NO_PATH_SUPPORT,
): ValidatedChangesInput | null {
  if (
    !hasExactFields(input, [
      'identity',
      'revision',
      'baseRevision',
      'inserted',
      'updated',
      'removed',
      'orders',
    ])
  ) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const identity = copyIdentity(record.identity);
  const revision = copyRevision(record.revision);
  const baseRevision = copyRevision(record.baseRevision);
  const inserted = copyArray(record.inserted, (entry) => copyNode(entry, pathNodes));
  const updated = copyArray(record.updated, (entry) => copyNode(entry, pathNodes));
  const removed = copyArray(record.removed, copyId);
  const orders = copyArray(record.orders, copyOrder);
  if (
    identity === null ||
    revision === null ||
    baseRevision === null ||
    inserted === null ||
    updated === null ||
    removed === null ||
    orders === null
  ) {
    return null;
  }
  return Object.freeze({ identity, revision, baseRevision, inserted, updated, removed, orders });
}

export function firstDuplicateNodeId(nodes: readonly ValidatedNode[]): string | null {
  const ids = new Set<string>();
  for (const { node } of nodes) {
    if (ids.has(node.id)) {
      return node.id;
    }
    ids.add(node.id);
  }
  return null;
}

export function validateCandidateGraph(
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
  rootOrder: readonly string[],
  hasUnsupportedFeature: boolean,
  arithmeticAlreadyValidated = false,
  support: PathSupport = NO_PATH_SUPPORT,
): SceneRejectionReason | null {
  // Arithmetic is an input-value property and therefore precedes graph categories.
  if (!arithmeticAlreadyValidated && !hasFiniteSceneArithmetic(nodes)) {
    return 'invalid-value';
  }

  // Unknown references are a complete category pass before parent validity.
  for (const node of sortedNodes(nodes)) {
    if (node.kind === 'container') {
      for (const childId of node.children) {
        if (!nodes.has(childId)) {
          return 'unknown-node';
        }
      }
    }
  }
  for (const childId of rootOrder) {
    if (!nodes.has(childId)) {
      return 'unknown-node';
    }
  }

  for (const node of sortedNodes(nodes)) {
    if (node.parentId !== null && !nodes.has(node.parentId)) {
      return 'invalid-parent';
    }
    if (node.parentId !== null && nodes.get(node.parentId)?.kind !== 'container') {
      return 'invalid-parent';
    }
  }

  if (hasParentCycle(nodes)) {
    return 'cycle';
  }
  if (!hasConsistentOrders(nodes, rootOrder)) {
    return 'invalid-order';
  }
  // P4 contract, P4-S2 and P4-S3: the mask-source and clip-depth rules are graph rules over the
  // whole candidate, so a change set that only reorders or reparents is checked as well.
  if (hasUnsupportedClipGraph(nodes, rootOrder, support)) {
    return 'unsupported-feature';
  }
  return hasUnsupportedFeature ? 'unsupported-feature' : null;
}

/**
 * P4-S2: a mask source (`children[0]` of a mask container) must not be a container, and a path
 * source needs a fill port whatever its style. Clip depth: no node may have more than
 * SCENE_MAX_CLIP_DEPTH clipping proper ancestors. One walk from the roots, O(n).
 */
function hasUnsupportedClipGraph(
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
  rootOrder: readonly string[],
  support: PathSupport,
): boolean {
  const pending: { id: string; depth: number }[] = rootOrder.map((id) => ({ id, depth: 0 }));
  while (pending.length > 0) {
    const { id, depth } = pending.pop()!;
    if (depth > SCENE_MAX_CLIP_DEPTH) return true;
    const node = nodes.get(id);
    if (node === undefined || node.kind !== 'container') continue;
    if (node.clip !== null && node.clip.kind === 'mask' && node.children.length > 0) {
      const source = nodes.get(node.children[0]!);
      if (source === undefined || source.kind === 'container') return true;
      if (source.kind === 'path' && support.pathFills !== 'supported') return true;
    }
    const childDepth = node.clip === null ? depth : depth + 1;
    for (const childId of node.children) pending.push({ id: childId, depth: childDepth });
  }
  return false;
}

function clipSupported(clip: SceneClip, support: ClipSupport): boolean {
  if (clip === null || support === 'supported') return true;
  return support === 'rect' && clip.kind === 'rect';
}

export function snapshotsEqual(
  leftNodes: ReadonlyMap<string, RenderNodeSnapshot>,
  leftRootOrder: readonly string[],
  rightNodes: ReadonlyMap<string, RenderNodeSnapshot>,
  rightRootOrder: readonly string[],
): boolean {
  if (leftNodes.size !== rightNodes.size || !arraysEqual(leftRootOrder, rightRootOrder)) {
    return false;
  }
  for (const [id, left] of leftNodes) {
    const right = rightNodes.get(id);
    if (right === undefined || !nodeEquals(left, right)) {
      return false;
    }
  }
  return true;
}

function copyNode(value: unknown, pathNodes: PathSupport): ValidatedNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  const fields =
    kind === 'primitive' || kind === 'path'
      ? ['id', 'parentId', 'transform', 'visible', 'opacity', 'kind', 'geometry', 'style']
      : kind === 'container'
        ? ['id', 'parentId', 'transform', 'visible', 'opacity', 'kind', 'children', 'clip']
        : null;
  if (fields === null || !hasExactFields(value, fields)) {
    return null;
  }

  const id = copyId(value.id);
  const parentId = value.parentId === null ? null : copyId(value.parentId);
  const transform = copyTuple(value.transform, 6, copyFiniteNumber) as SceneAffine | null;
  const visible = typeof value.visible === 'boolean' ? value.visible : null;
  const opacity = copyUnitNumber(value.opacity);
  if (
    id === null ||
    (value.parentId !== null && parentId === null) ||
    transform === null ||
    visible === null ||
    opacity === null
  ) {
    return null;
  }

  if (kind === 'container') {
    const children = copyArray(value.children, copyId);
    const clip = copyClip(value.clip);
    if (children === null || clip === undefined) {
      return null;
    }
    const node = Object.freeze({
      id,
      parentId,
      transform,
      visible,
      opacity,
      kind: 'container' as const,
      children,
      clip,
    });
    return Object.freeze({
      node,
      unsupported: opacity !== 1 || !clipSupported(clip, pathNodes.clips),
    });
  }

  if (kind === 'path') {
    // P3 V3 contract, section a: path content is validated here, so it precedes graph
    // checks; a path without a port is reported last as unsupported-feature.
    const geometry = copyPathGeometry(value.geometry);
    const style = copyPathStyle(value.style);
    if (geometry === null || style === null) {
      return null;
    }
    const node = Object.freeze({
      id,
      parentId,
      transform,
      visible,
      opacity,
      kind: 'path' as const,
      geometry,
      style,
    });
    // B2 stroke contract, section 5 and the section 9.1 amendment (S4): a stroke with
    // width > 0 needs a stroke port and a fill needs a fill port; each is reported in the same
    // last slot as a path without any port. A width-0 stroke is accepted and draws nothing.
    const unsupported =
      !paintsSupported([style.fill, style.stroke?.color ?? null], pathNodes) ||
      !dashSupported(style.stroke, pathNodes) ||
      pathNodes.pathNodes !== 'supported' ||
      (style.fill !== null && pathNodes.pathFills !== 'supported') ||
      (style.stroke !== null && style.stroke.width > 0 && pathNodes.pathStrokes !== 'supported');
    return Object.freeze({ node, unsupported });
  }

  const geometry = copyGeometry(value.geometry);
  const style = copyStyle(value.style);
  if (geometry === null || style === null) {
    return null;
  }
  const node = Object.freeze({
    id,
    parentId,
    transform,
    visible,
    opacity,
    kind: 'primitive' as const,
    geometry,
    style,
  });
  return Object.freeze({
    node,
    unsupported:
      (geometry.kind === 'line' && style.fill !== null) ||
      !paintsSupported([style.fill, style.stroke?.color ?? null], pathNodes),
  });
}

/**
 * E23-S2 and S3: a gradient paint is unsupported under `paints: 'solid'`, and with more than
 * SCENE_MAX_GRADIENT_STOPS stops. Both are reported after the graph checks.
 */
function paintsSupported(paints: readonly (ScenePaint | null)[], support: PathSupport): boolean {
  for (const paint of paints) {
    if (paint === null || !('kind' in paint)) continue;
    if (support.paints !== 'gradient' || paint.stops.length > SCENE_MAX_GRADIENT_STOPS) {
      return false;
    }
  }
  return true;
}

/**
 * E24-S1 and S3: a dash with more than SCENE_MAX_DASH_ENTRIES entries is unsupported, and so is
 * a dash on a stroke of width > 0 unless the renderer dashes. Both are reported after the graph
 * checks.
 */
function dashSupported(stroke: PathStroke | null, support: PathSupport): boolean {
  if (stroke === null || stroke.dash === undefined || stroke.dash === null) return true;
  if (stroke.dash.pattern.length > SCENE_MAX_DASH_ENTRIES) return false;
  // A stroke of width 0 draws nothing, so only the support gate exempts it.
  return !(stroke.width > 0) || support.dashes === 'supported';
}

/** P4-S1 and P4-S3: `undefined` marks an invalid clip, since `null` is a valid one. */
function copyClip(value: unknown): SceneClip | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (value.kind === 'mask') {
    return hasExactFields(value, ['kind']) ? Object.freeze({ kind: 'mask' as const }) : undefined;
  }
  if (value.kind !== 'rect' || !hasExactFields(value, ['kind', 'x', 'y', 'width', 'height'])) {
    return undefined;
  }
  const x = copyFiniteNumber(value.x);
  const y = copyFiniteNumber(value.y);
  const width = copyNonnegativeNumber(value.width);
  const height = copyNonnegativeNumber(value.height);
  return x === null ||
    y === null ||
    width === null ||
    height === null ||
    !Number.isFinite(x + width) ||
    !Number.isFinite(y + height)
    ? undefined
    : Object.freeze({ kind: 'rect' as const, x, y, width, height });
}

function copyGeometry(value: unknown): PrimitiveGeometry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === 'rectangle') {
    if (!hasExactFields(value, ['kind', 'width', 'height', 'cornerRadii'])) return null;
    const width = copyNonnegativeNumber(value.width);
    const height = copyNonnegativeNumber(value.height);
    const cornerRadii = copyTuple(value.cornerRadii, 4, copyNonnegativeNumber) as
      readonly [number, number, number, number] | null;
    return width === null || height === null || cornerRadii === null
      ? null
      : Object.freeze({ kind: 'rectangle', width, height, cornerRadii });
  }
  if (value.kind === 'ellipse') {
    if (!hasExactFields(value, ['kind', 'width', 'height'])) return null;
    const width = copyNonnegativeNumber(value.width);
    const height = copyNonnegativeNumber(value.height);
    return width === null || height === null
      ? null
      : Object.freeze({ kind: 'ellipse', width, height });
  }
  if (value.kind === 'line') {
    if (!hasExactFields(value, ['kind', 'start', 'end'])) return null;
    const start = copyPoint(value.start);
    const end = copyPoint(value.end);
    return start === null || end === null ? null : Object.freeze({ kind: 'line', start, end });
  }
  return null;
}

const PATH_VERB_POINTS: Readonly<Record<ScenePathVerb, number>> = Object.freeze({
  move: 1,
  line: 1,
  cubic: 3,
  close: 0,
});

function copyPathGeometry(value: unknown): ScenePathGeometry | null {
  if (!hasExactFields(value, ['kind', 'verbs', 'points', 'fillRule'])) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'path') return null;
  if (record.fillRule !== 'nonzero' && record.fillRule !== 'evenodd') return null;
  const verbs = copyArray(record.verbs, copyPathVerb);
  const points = copyArray(record.points, copyFiniteNumber);
  if (verbs === null || points === null || !hasPathGrammar(verbs)) return null;
  let pointCount = 0;
  for (const verb of verbs) pointCount += PATH_VERB_POINTS[verb];
  if (points.length !== pointCount * 2) return null;
  return Object.freeze({ kind: 'path', verbs, points, fillRule: record.fillRule });
}

function copyPathVerb(value: unknown): ScenePathVerb | null {
  return value === 'move' || value === 'line' || value === 'cubic' || value === 'close'
    ? value
    : null;
}

/** The P2 v1 grammar: MOVE opens a subpath; LINE and CUBIC need one; CLOSE ends one. */
function hasPathGrammar(verbs: readonly ScenePathVerb[]): boolean {
  let open = false;
  for (const verb of verbs) {
    if (verb === 'move') {
      open = true;
    } else if (verb === 'close') {
      if (!open) return false;
      open = false;
    } else if (!open) {
      return false;
    }
  }
  return true;
}

function copyPathStyle(value: unknown): PathStyle | null {
  // B2 stroke contract, section 5: exactly fill and stroke; stroke is required, null when absent.
  if (!hasExactFields(value, ['fill', 'stroke'])) return null;
  const record = value as Record<string, unknown>;
  const fill = record.fill === null ? null : copyPaint(record.fill);
  if (record.fill !== null && fill === null) return null;
  const stroke = record.stroke === null ? null : copyPathStroke(record.stroke);
  if (record.stroke !== null && stroke === null) return null;
  return Object.freeze({ fill, stroke });
}

/** B2 stroke contract, section 5 validation rows; every failure here is invalid-value. */
function copyPathStroke(value: unknown): PathStroke | null {
  // E24-S2: the five B2 fields and an optional `dash`, kept in the producer's form.
  const hasDash = isRecord(value) && Object.hasOwn(value, 'dash');
  const fields = ['color', 'width', 'cap', 'join', 'miterLimit'];
  if (!hasExactFields(value, hasDash ? [...fields, 'dash'] : fields)) return null;
  const record = value as Record<string, unknown>;
  const color = copyPaint(record.color);
  const width = copyNonnegativeNumber(record.width);
  const cap =
    record.cap === 'butt' || record.cap === 'round' || record.cap === 'square' ? record.cap : null;
  const join =
    record.join === 'miter' || record.join === 'round' || record.join === 'bevel'
      ? record.join
      : null;
  const miterLimit = copyFiniteNumber(record.miterLimit);
  if (
    color === null ||
    width === null ||
    cap === null ||
    join === null ||
    miterLimit === null ||
    miterLimit < 1
  ) {
    return null;
  }
  if (!hasDash) return Object.freeze({ color, width, cap, join, miterLimit });
  const dash = copyDash(record.dash);
  if (dash === undefined) return null;
  return Object.freeze({ color, width, cap, join, miterLimit, dash });
}

/**
 * E24-S1: `null`, or exactly `{ pattern, phase }` with at least one entry, every entry finite
 * and >= 0, at least one > 0, a finite period (the binary64 sum, left to right) and a finite
 * phase. `undefined` marks an invalid dash, since `null` is a valid one. More than
 * SCENE_MAX_DASH_ENTRIES entries is reported by `dashSupported`.
 */
function copyDash(value: unknown): SceneDash | null | undefined {
  if (value === null) return null;
  if (!hasExactFields(value, ['pattern', 'phase'])) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.pattern) || record.pattern.length === 0) return undefined;
  const pattern: number[] = [];
  let period = 0;
  let positive = false;
  for (let index = 0; index < record.pattern.length; index += 1) {
    if (!Object.hasOwn(record.pattern, index)) return undefined;
    const entry = copyNonnegativeNumber((record.pattern as unknown[])[index]);
    if (entry === null) return undefined;
    pattern.push(entry);
    period += entry;
    positive ||= entry > 0;
  }
  // E24-S1: the period is that of the list after E24-K1 doubles an odd pattern.
  if (pattern.length % 2 === 1) for (const entry of pattern) period += entry;
  const phase = copyFiniteNumber(record.phase);
  if (!positive || !Number.isFinite(period) || phase === null) return undefined;
  return Object.freeze({ pattern: Object.freeze(pattern), phase });
}

function copyStyle(value: unknown): PrimitiveStyle | null {
  if (!hasExactFields(value, ['fill', 'stroke'])) return null;
  const record = value as Record<string, unknown>;
  const fill = record.fill === null ? null : copyPaint(record.fill);
  const stroke = record.stroke === null ? null : copyStroke(record.stroke);
  if ((record.fill !== null && fill === null) || (record.stroke !== null && stroke === null)) {
    return null;
  }
  return Object.freeze({ fill, stroke });
}

function copyStroke(value: unknown): SceneStroke | null {
  if (!hasExactFields(value, ['color', 'width'])) return null;
  const record = value as Record<string, unknown>;
  const color = copyPaint(record.color);
  const width = copyNonnegativeNumber(record.width);
  return color === null || width === null ? null : Object.freeze({ color, width });
}

/** E23-S1: exactly r, g, b, a is a solid colour; exactly the gradient fields is a gradient. */
function copyPaint(value: unknown): ScenePaint | null {
  return isRecord(value) && Object.hasOwn(value, 'kind') ? copyGradient(value) : copyColor(value);
}

/**
 * E23-S2: every field is an input value (`invalid-value`), the stop count included up to any
 * length; more than SCENE_MAX_GRADIENT_STOPS stops is reported by `paintsSupported`.
 */
function copyGradient(value: unknown): SceneGradient | null {
  if (!hasExactFields(value, ['kind', 'transform', 'stops', 'spread'])) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'linear' || record.kind === 'radial' ? record.kind : null;
  const spread =
    record.spread === 'pad' || record.spread === 'reflect' || record.spread === 'repeat'
      ? record.spread
      : null;
  const transform = copyTuple(record.transform, 6, copyFiniteNumber) as SceneAffine | null;
  const stops = copyArray(record.stops, copyGradientStop);
  if (
    kind === null ||
    spread === null ||
    transform === null ||
    !hasFiniteInverse(transform) ||
    stops === null ||
    stops.length === 0
  ) {
    return null;
  }
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index]!.offset < stops[index - 1]!.offset) return null;
  }
  return Object.freeze({ kind, transform, stops, spread });
}

function copyGradientStop(value: unknown): SceneGradientStop | null {
  if (!hasExactFields(value, ['offset', 'color'])) return null;
  const record = value as Record<string, unknown>;
  const offset = copyUnitNumber(record.offset);
  const color = copyColor(record.color);
  return offset === null || color === null ? null : Object.freeze({ offset, color });
}

/** E23-S2: the binary64 determinant is non-zero and the binary64 inverse is finite. */
function hasFiniteInverse([a, b, c, d, e, f]: SceneAffine): boolean {
  const determinant = a * d - b * c;
  if (determinant === 0 || !Number.isFinite(determinant)) return false;
  const inverse = [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
  return inverse.every(Number.isFinite);
}

function copyColor(value: unknown): SceneColor | null {
  if (!hasExactFields(value, ['r', 'g', 'b', 'a'])) return null;
  const record = value as Record<string, unknown>;
  const r = copyUnitNumber(record.r);
  const g = copyUnitNumber(record.g);
  const b = copyUnitNumber(record.b);
  const a = copyUnitNumber(record.a);
  return r === null || g === null || b === null || a === null
    ? null
    : Object.freeze({ r, g, b, a });
}

function copyPoint(value: unknown): ScenePoint | null {
  if (!hasExactFields(value, ['x', 'y'])) return null;
  const record = value as Record<string, unknown>;
  const x = copyFiniteNumber(record.x);
  const y = copyFiniteNumber(record.y);
  return x === null || y === null ? null : Object.freeze({ x, y });
}

function copyIdentity(value: unknown): SceneIdentity | null {
  if (!hasExactFields(value, ['documentId', 'pageId'])) return null;
  const record = value as Record<string, unknown>;
  const documentId = copyId(record.documentId);
  const pageId = copyId(record.pageId);
  return documentId === null || pageId === null ? null : Object.freeze({ documentId, pageId });
}

function copyOrder(value: unknown): RenderChildOrder | null {
  if (!hasExactFields(value, ['parentId', 'children'])) return null;
  const record = value as Record<string, unknown>;
  const parentId = record.parentId === null ? null : copyId(record.parentId);
  const children = copyArray(record.children, copyId);
  return (record.parentId !== null && parentId === null) || children === null
    ? null
    : Object.freeze({ parentId, children });
}

function copyId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function copyFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function copyNonnegativeNumber(value: unknown): number | null {
  const number = copyFiniteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function copyUnitNumber(value: unknown): number | null {
  const number = copyFiniteNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function copyRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function copyTuple(
  value: unknown,
  length: number,
  copyEntry: (entry: unknown) => number | null,
): readonly number[] | null {
  if (!isExactArray(value) || value.length !== length) return null;
  const result: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = copyEntry(value[index]);
    if (entry === null) return null;
    result.push(entry);
  }
  return Object.freeze(result);
}

function copyArray<T>(
  value: unknown,
  copyEntry: (entry: unknown) => T | null,
): readonly T[] | null {
  if (!isExactArray(value)) return null;
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = copyEntry(value[index]);
    if (entry === null) return null;
    result.push(entry);
  }
  return Object.freeze(result);
}

function isExactArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((field) => Object.hasOwn(value, field)) &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function sortedNodes(
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
): readonly RenderNodeSnapshot[] {
  return [...nodes.values()].sort((left, right) => compareOrdinal(left.id, right.id));
}

function hasParentCycle(nodes: ReadonlyMap<string, RenderNodeSnapshot>): boolean {
  const complete = new Set<string>();
  for (const start of sortedNodes(nodes)) {
    if (complete.has(start.id)) continue;
    const path = new Set<string>();
    let cursor: RenderNodeSnapshot | undefined = start;
    while (cursor !== undefined && !complete.has(cursor.id)) {
      if (path.has(cursor.id)) return true;
      path.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : nodes.get(cursor.parentId);
    }
    for (const id of path) complete.add(id);
  }
  return false;
}

function hasConsistentOrders(
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
  rootOrder: readonly string[],
): boolean {
  const occurrences = new Map<string, number>();
  const inspect = (parentId: string | null, children: readonly string[]): boolean => {
    const local = new Set<string>();
    for (const childId of children) {
      if (local.has(childId) || nodes.get(childId)?.parentId !== parentId) return false;
      local.add(childId);
      occurrences.set(childId, (occurrences.get(childId) ?? 0) + 1);
    }
    return true;
  };
  if (!inspect(null, rootOrder)) return false;
  for (const node of sortedNodes(nodes)) {
    if (node.kind === 'container' && !inspect(node.id, node.children)) return false;
  }
  return [...nodes.keys()].every((id) => occurrences.get(id) === 1);
}

function clipEquals(left: SceneClip, right: SceneClip): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === 'mask' || right.kind === 'mask') return left.kind === right.kind;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function nodeEquals(left: RenderNodeSnapshot, right: RenderNodeSnapshot): boolean {
  if (
    left.id !== right.id ||
    left.parentId !== right.parentId ||
    left.visible !== right.visible ||
    left.opacity !== right.opacity ||
    left.kind !== right.kind ||
    !arraysEqual(left.transform, right.transform)
  )
    return false;
  if (left.kind === 'container' && right.kind === 'container') {
    return arraysEqual(left.children, right.children) && clipEquals(left.clip, right.clip);
  }
  if (left.kind === 'path' && right.kind === 'path') {
    return (
      pathDataEquals(left.geometry, right.geometry) &&
      left.geometry.fillRule === right.geometry.fillRule &&
      nullablePaintEquals(left.style.fill, right.style.fill) &&
      nullablePathStrokeEquals(left.style.stroke, right.style.stroke)
    );
  }
  if (left.kind !== 'primitive' || right.kind !== 'primitive') return false;
  return geometryEquals(left.geometry, right.geometry) && styleEquals(left.style, right.style);
}

/** Path data equality under the replay rule (`===`); it also decides geometry-revision reuse. */
export function pathDataEquals(left: ScenePathGeometry, right: ScenePathGeometry): boolean {
  return arraysEqual(left.verbs, right.verbs) && arraysEqual(left.points, right.points);
}

function geometryEquals(left: PrimitiveGeometry, right: PrimitiveGeometry): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'rectangle' && right.kind === 'rectangle') {
    return (
      left.width === right.width &&
      left.height === right.height &&
      arraysEqual(left.cornerRadii, right.cornerRadii)
    );
  }
  if (left.kind === 'ellipse' && right.kind === 'ellipse') {
    return left.width === right.width && left.height === right.height;
  }
  return (
    left.kind === 'line' &&
    right.kind === 'line' &&
    pointEquals(left.start, right.start) &&
    pointEquals(left.end, right.end)
  );
}

function styleEquals(left: PrimitiveStyle, right: PrimitiveStyle): boolean {
  return (
    nullablePaintEquals(left.fill, right.fill) && nullableStrokeEquals(left.stroke, right.stroke)
  );
}

function nullableStrokeEquals(left: SceneStroke | null, right: SceneStroke | null): boolean {
  return left === null || right === null
    ? left === right
    : left.width === right.width && paintEquals(left.color, right.color);
}

/** B2 stroke contract, section 5: every stroke field with `===`, color channels included. */
function nullablePathStrokeEquals(left: PathStroke | null, right: PathStroke | null): boolean {
  return left === null || right === null
    ? left === right
    : left.width === right.width &&
        left.cap === right.cap &&
        left.join === right.join &&
        left.miterLimit === right.miterLimit &&
        paintEquals(left.color, right.color) &&
        nullableDashEquals(left.dash ?? null, right.dash ?? null);
}

/** E24-S2: absent and null are equal; patterns entry by entry, and the phase, with `===`. */
function nullableDashEquals(left: SceneDash | null, right: SceneDash | null): boolean {
  return left === null || right === null
    ? left === right
    : left.phase === right.phase &&
        left.pattern.length === right.pattern.length &&
        left.pattern.every((entry, index) => entry === right.pattern[index]);
}

function nullablePaintEquals(left: ScenePaint | null, right: ScenePaint | null): boolean {
  return left === null || right === null ? left === right : paintEquals(left, right);
}

/** E23 contract: every paint field with `===` under the replay rule, stops in order. */
function paintEquals(left: ScenePaint, right: ScenePaint): boolean {
  if (!('kind' in left) || !('kind' in right)) {
    return !('kind' in left) && !('kind' in right) && colorEquals(left, right);
  }
  return (
    left.kind === right.kind &&
    left.spread === right.spread &&
    arraysEqual(left.transform, right.transform) &&
    left.stops.length === right.stops.length &&
    left.stops.every(
      (stop, index) =>
        stop.offset === right.stops[index]!.offset &&
        colorEquals(stop.color, right.stops[index]!.color),
    )
  );
}

function colorEquals(left: SceneColor, right: SceneColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a;
}

function pointEquals(left: ScenePoint, right: ScenePoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
