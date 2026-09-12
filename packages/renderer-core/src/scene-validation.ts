import type {
  PrimitiveGeometry,
  PrimitiveStyle,
  RenderChildOrder,
  RenderNodeSnapshot,
  SceneAffine,
  SceneColor,
  SceneIdentity,
  ScenePoint,
  SceneRejectionReason,
  SceneStroke,
} from '@vector-studio/contracts';
import { hasFiniteSceneArithmetic } from './scene-numeric.js';

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

export function validateSnapshotShape(input: unknown): ValidatedSnapshotInput | null {
  if (!hasExactFields(input, ['identity', 'revision', 'nodes', 'rootOrder'])) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const identity = copyIdentity(record.identity);
  const revision = copyRevision(record.revision);
  const nodes = copyArray(record.nodes, copyNode);
  const rootOrder = copyArray(record.rootOrder, copyId);
  if (identity === null || revision === null || nodes === null || rootOrder === null) {
    return null;
  }
  return Object.freeze({ identity, revision, nodes, rootOrder });
}

export function validateChangesShape(input: unknown): ValidatedChangesInput | null {
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
  const inserted = copyArray(record.inserted, copyNode);
  const updated = copyArray(record.updated, copyNode);
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
  return hasUnsupportedFeature ? 'unsupported-feature' : null;
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

function copyNode(value: unknown): ValidatedNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  const fields =
    kind === 'primitive'
      ? ['id', 'parentId', 'transform', 'visible', 'opacity', 'kind', 'geometry', 'style']
      : kind === 'container'
        ? ['id', 'parentId', 'transform', 'visible', 'opacity', 'kind', 'children']
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
    if (children === null) {
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
    });
    return Object.freeze({ node, unsupported: opacity !== 1 });
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
    unsupported: geometry.kind === 'line' && style.fill !== null,
  });
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

function copyStyle(value: unknown): PrimitiveStyle | null {
  if (!hasExactFields(value, ['fill', 'stroke'])) return null;
  const record = value as Record<string, unknown>;
  const fill = record.fill === null ? null : copyColor(record.fill);
  const stroke = record.stroke === null ? null : copyStroke(record.stroke);
  if ((record.fill !== null && fill === null) || (record.stroke !== null && stroke === null)) {
    return null;
  }
  return Object.freeze({ fill, stroke });
}

function copyStroke(value: unknown): SceneStroke | null {
  if (!hasExactFields(value, ['color', 'width'])) return null;
  const record = value as Record<string, unknown>;
  const color = copyColor(record.color);
  const width = copyNonnegativeNumber(record.width);
  return color === null || width === null ? null : Object.freeze({ color, width });
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
    return arraysEqual(left.children, right.children);
  }
  if (left.kind !== 'primitive' || right.kind !== 'primitive') return false;
  return geometryEquals(left.geometry, right.geometry) && styleEquals(left.style, right.style);
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
    nullableColorEquals(left.fill, right.fill) && nullableStrokeEquals(left.stroke, right.stroke)
  );
}

function nullableStrokeEquals(left: SceneStroke | null, right: SceneStroke | null): boolean {
  return left === null || right === null
    ? left === right
    : left.width === right.width && colorEquals(left.color, right.color);
}

function nullableColorEquals(left: SceneColor | null, right: SceneColor | null): boolean {
  return left === null || right === null ? left === right : colorEquals(left, right);
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
