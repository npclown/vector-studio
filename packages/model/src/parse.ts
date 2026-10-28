import { MAX_DEPTH, scanJson } from './json-scan.js';
import type {
  Arrow,
  Color,
  Constraint,
  Constraints,
  DocumentV1,
  DocumentV2,
  NodeV2,
  PageV2,
  FillRule,
  Frame,
  JsonValue,
  NodeV1,
  PageV1,
  PathData,
  PathStroke,
  PathVerb,
  RectStroke,
  StrokeCap,
  StrokeJoin,
} from './types.js';

/**
 * Section 3.3 codes, then the schema v2 codes. `unknown-custom-type` and `invalid-custom-data` are
 * checked by `editor-core` on load, never by the model.
 */
export const DOCUMENT_ERROR_CODES = [
  'document.malformed-json',
  'document.unsupported-version',
  'document.invalid-field',
  'document.duplicate-id',
  'document.dangling-reference',
  'document.unknown-custom-type',
  'document.invalid-custom-data',
  // Schema v2 (MVP M1 contract, section 2).
  'document.cyclic-parent',
  'document.invalid-mask-source',
] as const;

export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[number];

/** The codes the model itself returns. */
export type ModelErrorCode = Exclude<
  DocumentErrorCode,
  'document.unknown-custom-type' | 'document.invalid-custom-data'
>;

/** `path` is a JSON Pointer (RFC 6901) to the offending field; `''` is the whole document. */
export type ParseResult =
  | Readonly<{ ok: true; document: DocumentV1 }>
  | Readonly<{ ok: false; code: ModelErrorCode; path: string }>;

/** IDs are opaque non-empty strings, unique across the document's pages and nodes. */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parses JSON text into a validated document; no partial document is ever returned. */
export function parseDocument(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'document.malformed-json', path: '' };
  }
  const version = checkVersion(value);
  if (version !== null) return version;
  // JSON.parse keeps the last of two equal keys, which would silently drop an entity. The scan
  // also bounds nesting, so validation never recurses deeper than MAX_DEPTH.
  const finding = scanJson(text);
  if (finding !== null) {
    const nodeKey =
      finding.kind === 'duplicate-key' && finding.path.length === 2 && finding.path[0] === 'nodes';
    return {
      ok: false,
      code: nodeKey ? 'document.duplicate-id' : 'document.invalid-field',
      path: pointer(finding.path),
    };
  }
  return validateDocument(value);
}

/**
 * Validates a document value, for example one built in memory, and returns a normalized copy:
 * negative zero becomes 0 and nothing is shared with the input.
 */
export function validateDocument(value: unknown): ParseResult {
  const version = checkVersion(value);
  if (version !== null) return version;
  try {
    return { ok: true, document: readDocument(value as Record<string, unknown>) };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

export type NodeResult =
  | Readonly<{ ok: true; node: NodeV1 }>
  | Readonly<{ ok: false; code: 'document.invalid-field'; path: string }>;

/**
 * Validates one node with the field rules of `validateDocument`, so commands reject the values
 * a load would reject. `path` is relative to the node; references are not checked here.
 */
export function validateNode(value: unknown): NodeResult {
  try {
    const id = isPlainObject(value) ? value.id : undefined;
    return { ok: true, node: readNode(typeof id === 'string' ? id : '', value, []) };
  } catch (error) {
    if (error instanceof Failure) {
      return { ok: false, code: 'document.invalid-field', path: pointer(error.path) };
    }
    throw error;
  }
}

type Path = readonly (string | number)[];

class Failure extends Error {
  constructor(
    readonly code: ModelErrorCode,
    readonly path: Path,
  ) {
    super(`${code} at ${pointer(path)}`);
  }
}

function invalid(path: Path): never {
  throw new Failure('document.invalid-field', path);
}

function pointer(path: Path): string {
  return path
    .map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

function checkVersion(value: unknown): ParseResult | null {
  if (!isPlainObject(value)) return { ok: false, code: 'document.invalid-field', path: '' };
  if (value.schemaVersion !== 1) {
    return { ok: false, code: 'document.unsupported-version', path: '/schemaVersion' };
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Requires exactly `keys`, reporting a missing key before an unknown one. */
function readRecord(value: unknown, keys: readonly string[], path: Path): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(path);
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid([...path, key]);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid([...path, key]);
  return value;
}

function readNumber(value: unknown, path: Path, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(path);
  }
  return value === 0 ? 0 : value;
}

function readString(value: unknown, path: Path): string {
  if (typeof value !== 'string') invalid(path);
  return value;
}

function readId(value: unknown, path: Path): string {
  if (!isValidId(value)) invalid(path);
  return value;
}

function readBoolean(value: unknown, path: Path): boolean {
  if (typeof value !== 'boolean') invalid(path);
  return value;
}

function readEnum<T extends string>(value: unknown, options: readonly T[], path: Path): T {
  if (!options.includes(value as T)) invalid(path);
  return value as T;
}

/** Reads every index, holes included: a sparse array fails on its first hole. */
function readArray<T>(
  value: unknown,
  path: Path,
  read: (entry: unknown, path: Path, index: number) => T,
): T[] {
  if (!Array.isArray(value)) invalid(path);
  const items: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    items.push(read(value[index], [...path, index], index));
  }
  return items;
}

function readColor(value: unknown, path: Path): Color {
  const record = readRecord(value, ['r', 'g', 'b', 'a'], path);
  return {
    r: readNumber(record.r, [...path, 'r'], 0, 1),
    g: readNumber(record.g, [...path, 'g'], 0, 1),
    b: readNumber(record.b, [...path, 'b'], 0, 1),
    a: readNumber(record.a, [...path, 'a'], 0, 1),
  };
}

function readNullable<T>(value: unknown, path: Path, read: (value: unknown, path: Path) => T) {
  return value === null ? null : read(value, path);
}

function readFrame(value: unknown, path: Path): Frame {
  const record = readRecord(value, ['x', 'y', 'width', 'height'], path);
  return {
    x: readNumber(record.x, [...path, 'x']),
    y: readNumber(record.y, [...path, 'y']),
    width: readNumber(record.width, [...path, 'width'], 0),
    height: readNumber(record.height, [...path, 'height'], 0),
  };
}

function readRectStroke(value: unknown, path: Path): RectStroke {
  const record = readRecord(value, ['color', 'width'], path);
  return {
    color: readColor(record.color, [...path, 'color']),
    width: readNumber(record.width, [...path, 'width'], 0),
  };
}

const CAPS: readonly StrokeCap[] = ['butt', 'round', 'square'];
const JOINS: readonly StrokeJoin[] = ['miter', 'round', 'bevel'];

function readPathStroke(value: unknown, path: Path): PathStroke {
  const record = readRecord(value, ['color', 'width', 'cap', 'join', 'miterLimit'], path);
  return {
    color: readColor(record.color, [...path, 'color']),
    width: readNumber(record.width, [...path, 'width'], 0),
    cap: readEnum(record.cap, CAPS, [...path, 'cap']),
    join: readEnum(record.join, JOINS, [...path, 'join']),
    miterLimit: readNumber(record.miterLimit, [...path, 'miterLimit'], 1),
  };
}

const VERBS: readonly PathVerb[] = ['move', 'line', 'cubic', 'close'];
const VERB_POINTS: Readonly<Record<PathVerb, number>> = { move: 1, line: 1, cubic: 3, close: 0 };
const FILL_RULES: readonly FillRule[] = ['nonzero', 'evenodd'];

function readPathData(value: unknown, path: Path): PathData {
  const record = readRecord(value, ['verbs', 'points', 'fillRule'], path);
  const verbsPath = [...path, 'verbs'];
  // The renderer's path grammar: move opens a subpath, line and cubic need one, close ends one.
  let open = false;
  let pointCount = 0;
  const verbs = readArray(record.verbs, verbsPath, (entry, entryPath) => {
    const verb = readEnum(entry, VERBS, entryPath);
    if (verb !== 'move' && !open) invalid(entryPath);
    open = verb !== 'close';
    pointCount += VERB_POINTS[verb];
    return verb;
  });
  const pointsPath = [...path, 'points'];
  const points = readArray(record.points, pointsPath, (entry, entryPath) =>
    readNumber(entry, entryPath, 0, 1),
  );
  if (points.length !== pointCount * 2) invalid(pointsPath);
  return { verbs, points, fillRule: readEnum(record.fillRule, FILL_RULES, [...path, 'fillRule']) };
}

// Custom data sits below the document, nodes and node containers, so in-memory values get the
// same nesting bound as text (MAX_DEPTH); this also stops a cyclic value.
const MAX_DATA_DEPTH = MAX_DEPTH - 3;

function readJson(value: unknown, path: Path, depth = 1): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return readNumber(value, path);
  if (depth > MAX_DATA_DEPTH) invalid(path);
  if (Array.isArray(value)) {
    return readArray(value, path, (entry, entryPath) => readJson(entry, entryPath, depth + 1));
  }
  if (!isPlainObject(value)) invalid(path);
  // fromEntries defines own properties, so a "__proto__" key stays data.
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, readJson(entry, [...path, key], depth + 1)]),
  );
}

const BASE_KEYS = ['id', 'name', 'parent', 'frame', 'opacity', 'visible', 'type'] as const;
const NODE_KEYS = {
  rectangle: [...BASE_KEYS, 'fill', 'stroke'],
  path: [...BASE_KEYS, 'path', 'fill', 'stroke'],
  custom: [...BASE_KEYS, 'customType', 'data', 'fill', 'stroke'],
} as const;
type NodeType = keyof typeof NODE_KEYS;

function readNode(key: string, value: unknown, path: Path): NodeV1 {
  if (!isPlainObject(value)) invalid(path);
  const type = readEnum(value.type, Object.keys(NODE_KEYS) as NodeType[], [...path, 'type']);
  const record = readRecord(value, NODE_KEYS[type], path);
  if (!isValidId(key) || record.id !== key) invalid([...path, 'id']);
  const base = {
    id: key,
    name: readString(record.name, [...path, 'name']),
    parent: readId(record.parent, [...path, 'parent']),
    frame: readFrame(record.frame, [...path, 'frame']),
    opacity: readNumber(record.opacity, [...path, 'opacity'], 0, 1),
    visible: readBoolean(record.visible, [...path, 'visible']),
  };
  switch (type) {
    case 'rectangle':
      return {
        ...base,
        type,
        fill: readNullable(record.fill, [...path, 'fill'], readColor),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readRectStroke),
      };
    case 'path':
      return {
        ...base,
        type,
        path: readPathData(record.path, [...path, 'path']),
        fill: readNullable(record.fill, [...path, 'fill'], readColor),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readPathStroke),
      };
    case 'custom':
      return {
        ...base,
        type,
        customType: readId(record.customType, [...path, 'customType']),
        data: readJson(record.data, [...path, 'data']),
        fill: readNullable(record.fill, [...path, 'fill'], readColor),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readPathStroke),
      };
  }
}

function readPage(value: unknown, path: Path): PageV1 {
  const record = readRecord(value, ['id', 'name', 'children'], path);
  const childrenPath = [...path, 'children'];
  return {
    id: readId(record.id, [...path, 'id']),
    name: readString(record.name, [...path, 'name']),
    children: readArray(record.children, childrenPath, readId),
  };
}

function readDocument(value: Record<string, unknown>): DocumentV1 {
  const record = readRecord(value, ['schemaVersion', 'id', 'pages', 'nodes'], []);
  const id = readId(record.id, ['id']);
  if (!Array.isArray(record.pages) || record.pages.length !== 1) invalid(['pages']);
  const page = readPage(record.pages[0], ['pages', 0]);
  if (!isPlainObject(record.nodes)) invalid(['nodes']);
  const entries = Object.entries(record.nodes).map(
    ([key, node]) => [key, readNode(key, node, ['nodes', key])] as const,
  );
  const nodes: Record<string, NodeV1> = Object.fromEntries(entries);

  if (Object.hasOwn(nodes, page.id)) {
    throw new Failure('document.duplicate-id', ['nodes', page.id]);
  }
  // Every node sits in exactly one children list, the one its parent owns.
  const owner = new Map<string, string>();
  page.children.forEach((child, index) => {
    const childPath = ['pages', 0, 'children', index];
    if (!Object.hasOwn(nodes, child) || owner.has(child)) {
      throw new Failure('document.dangling-reference', childPath);
    }
    owner.set(child, page.id);
  });
  for (const [key, node] of entries) {
    if (node.parent !== page.id && !Object.hasOwn(nodes, node.parent)) {
      throw new Failure('document.dangling-reference', ['nodes', key, 'parent']);
    }
    if (owner.get(key) !== node.parent) {
      throw new Failure('document.dangling-reference', ['nodes', key, 'parent']);
    }
  }
  return { schemaVersion: 1, id, pages: [page], nodes };
}

// Schema v2 (MVP M1 contract, section 2). `parseDocumentV2` and `validateAnyDocument` accept v1
// and v2 and return v2; v1 is migrated by `migrateV1toV2`. Until editor-core moves to v2 (M1-U2)
// the v1 functions above stay as they are.

export type ParseResultV2 =
  | Readonly<{ ok: true; document: DocumentV2 }>
  | Readonly<{ ok: false; code: ModelErrorCode; path: string }>;

export type NodeResultV2 =
  | Readonly<{ ok: true; node: NodeV2 }>
  | Readonly<{ ok: false; code: 'document.invalid-field'; path: string }>;

/** Deepest container nesting of the node tree (ancestors that are containers). */
export const MAX_TREE_DEPTH = 256;

/** Parses JSON text of schema version 1 or 2 into a validated v2 document. */
export function parseDocumentV2(text: string): ParseResultV2 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'document.malformed-json', path: '' };
  }
  const version = checkAnyVersion(value);
  if (version !== null) return version;
  const finding = scanJson(text);
  if (finding !== null) {
    const nodeKey =
      finding.kind === 'duplicate-key' && finding.path.length === 2 && finding.path[0] === 'nodes';
    return {
      ok: false,
      code: nodeKey ? 'document.duplicate-id' : 'document.invalid-field',
      path: pointer(finding.path),
    };
  }
  return validateAnyDocument(value);
}

/** Validates an in-memory v1 or v2 value and returns a normalized v2 copy. */
export function validateAnyDocument(value: unknown): ParseResultV2 {
  const version = checkAnyVersion(value);
  if (version !== null) return version;
  if ((value as Record<string, unknown>).schemaVersion === 1) {
    const v1 = validateDocument(value);
    return v1.ok ? migrateV1toV2(v1.document) : v1;
  }
  return guarded(() => readDocumentV2(value as Record<string, unknown>));
}

/**
 * Adds `rotation: 0`, start constraints on every node and zero corner radii on rectangles, and
 * changes nothing else; the result is validated with the v2 rules (U+0000 in an ID fails).
 */
export function migrateV1toV2(document: DocumentV1): ParseResultV2 {
  const nodes = Object.fromEntries(
    Object.entries(document.nodes).map(([key, node]) => {
      const migrated: Record<string, unknown> = {
        ...node,
        rotation: 0,
        constraints: { horizontal: 'start', vertical: 'start' },
      };
      if (node.type === 'rectangle') migrated.cornerRadii = [0, 0, 0, 0];
      return [key, migrated];
    }),
  );
  return guarded(() =>
    readDocumentV2({
      schemaVersion: 2,
      id: document.id,
      pages: document.pages.map((page) => ({ ...page, children: [...page.children] })),
      nodes,
    }),
  );
}

/** Validates one v2 node with the field rules of `validateAnyDocument`; references unchecked. */
export function validateNodeV2(value: unknown): NodeResultV2 {
  try {
    const id = isPlainObject(value) ? value.id : undefined;
    return { ok: true, node: readNodeV2(typeof id === 'string' ? id : '', value, []) };
  } catch (error) {
    if (error instanceof Failure) {
      return { ok: false, code: 'document.invalid-field', path: pointer(error.path) };
    }
    throw error;
  }
}

/** Normalizes radians to (−π, π], negative zero to 0 (contract M1-S1). */
export function normalizeRotation(theta: number): number {
  let t = theta - 2 * Math.PI * Math.round(theta / (2 * Math.PI));
  if (t <= -Math.PI) t += 2 * Math.PI;
  if (t > Math.PI) t -= 2 * Math.PI;
  return t === 0 ? 0 : t;
}

function guarded(read: () => DocumentV2): ParseResultV2 {
  try {
    return { ok: true, document: read() };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

function checkAnyVersion(value: unknown): ParseResultV2 | null {
  if (!isPlainObject(value)) return { ok: false, code: 'document.invalid-field', path: '' };
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    return { ok: false, code: 'document.unsupported-version', path: '/schemaVersion' };
  }
  return null;
}

/** v2 IDs may not contain U+0000, which synthetic scene IDs use (M1-S4). */
function isValidIdV2(value: unknown): value is string {
  return isValidId(value) && !value.includes('\u0000');
}

function readIdV2(value: unknown, path: Path): string {
  if (!isValidIdV2(value)) invalid(path);
  return value;
}

const CONSTRAINTS: readonly Constraint[] = ['start', 'end', 'startEnd', 'center', 'scale'];
const ARROWS: readonly Arrow[] = ['none', 'line', 'triangle'];

function readConstraints(value: unknown, path: Path): Constraints {
  const record = readRecord(value, ['horizontal', 'vertical'], path);
  return {
    horizontal: readEnum(record.horizontal, CONSTRAINTS, [...path, 'horizontal']),
    vertical: readEnum(record.vertical, CONSTRAINTS, [...path, 'vertical']),
  };
}

function readTuple4(value: unknown, path: Path, min: number, max: number) {
  if (!Array.isArray(value) || value.length !== 4) invalid(path);
  const items = readArray(value, path, (entry, entryPath) =>
    readNumber(entry, entryPath, min, max),
  );
  return [items[0]!, items[1]!, items[2]!, items[3]!] as const;
}

const BASE_KEYS_V2 = [
  'id',
  'name',
  'parent',
  'frame',
  'rotation',
  'constraints',
  'opacity',
  'visible',
  'type',
] as const;
const NODE_KEYS_V2 = {
  rectangle: [...BASE_KEYS_V2, 'cornerRadii', 'fill', 'stroke'],
  ellipse: [...BASE_KEYS_V2, 'fill', 'stroke'],
  line: [...BASE_KEYS_V2, 'points', 'stroke', 'startArrow', 'endArrow'],
  path: [...BASE_KEYS_V2, 'path', 'fill', 'stroke'],
  custom: [...BASE_KEYS_V2, 'customType', 'data', 'fill', 'stroke'],
  group: [...BASE_KEYS_V2, 'children'],
  maskGroup: [...BASE_KEYS_V2, 'children'],
  frame: [...BASE_KEYS_V2, 'children', 'fill', 'stroke'],
} as const;
type NodeTypeKey = keyof typeof NODE_KEYS_V2;

function isContainerType(type: string): boolean {
  return type === 'group' || type === 'maskGroup' || type === 'frame';
}

function readNodeV2(key: string, value: unknown, path: Path): NodeV2 {
  if (!isPlainObject(value)) invalid(path);
  const type = readEnum(value.type, Object.keys(NODE_KEYS_V2) as NodeTypeKey[], [...path, 'type']);
  const record = readRecord(value, NODE_KEYS_V2[type], path);
  if (!isValidIdV2(key) || record.id !== key) invalid([...path, 'id']);
  const base = {
    id: key,
    name: readString(record.name, [...path, 'name']),
    parent: readIdV2(record.parent, [...path, 'parent']),
    frame: readFrame(record.frame, [...path, 'frame']),
    rotation: normalizeRotation(readNumber(record.rotation, [...path, 'rotation'])),
    constraints: readConstraints(record.constraints, [...path, 'constraints']),
    opacity: readNumber(record.opacity, [...path, 'opacity'], 0, 1),
    visible: readBoolean(record.visible, [...path, 'visible']),
  };
  // Container opacity other than 1 waits for isolated composition (M1-S5).
  if (isContainerType(type) && base.opacity !== 1) invalid([...path, 'opacity']);
  const fill = () => readNullable(record.fill, [...path, 'fill'], readColor);
  const children = () =>
    readArray(record.children, [...path, 'children'], (entry, entryPath) =>
      readIdV2(entry, entryPath),
    );
  switch (type) {
    case 'rectangle':
      return {
        ...base,
        type,
        cornerRadii: readTuple4(record.cornerRadii, [...path, 'cornerRadii'], 0, Infinity),
        fill: fill(),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readRectStroke),
      };
    case 'ellipse':
      return {
        ...base,
        type,
        fill: fill(),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readRectStroke),
      };
    case 'line':
      return {
        ...base,
        type,
        points: readTuple4(record.points, [...path, 'points'], 0, 1),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readPathStroke),
        startArrow: readEnum(record.startArrow, ARROWS, [...path, 'startArrow']),
        endArrow: readEnum(record.endArrow, ARROWS, [...path, 'endArrow']),
      };
    case 'path':
      return {
        ...base,
        type,
        path: readPathData(record.path, [...path, 'path']),
        fill: fill(),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readPathStroke),
      };
    case 'custom':
      return {
        ...base,
        type,
        customType: readId(record.customType, [...path, 'customType']),
        data: readJson(record.data, [...path, 'data']),
        fill: fill(),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readPathStroke),
      };
    case 'group':
    case 'maskGroup':
      return { ...base, type, children: children() };
    case 'frame':
      return {
        ...base,
        type,
        children: children(),
        fill: fill(),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readRectStroke),
      };
  }
}

function readPageV2(value: unknown, path: Path): PageV2 {
  const record = readRecord(value, ['id', 'name', 'children'], path);
  return {
    id: readIdV2(record.id, [...path, 'id']),
    name: readString(record.name, [...path, 'name']),
    children: readArray(record.children, [...path, 'children'], (entry, entryPath) =>
      readIdV2(entry, entryPath),
    ),
  };
}

function readDocumentV2(value: Record<string, unknown>): DocumentV2 {
  const record = readRecord(value, ['schemaVersion', 'id', 'pages', 'nodes'], []);
  const id = readIdV2(record.id, ['id']);
  if (!Array.isArray(record.pages) || record.pages.length === 0) invalid(['pages']);
  const pages = readArray(record.pages, ['pages'], readPageV2);
  if (!isPlainObject(record.nodes)) invalid(['nodes']);
  const entries = Object.entries(record.nodes).map(
    ([key, node]) => [key, readNodeV2(key, node, ['nodes', key])] as const,
  );
  const nodes: Record<string, NodeV2> = Object.fromEntries(entries);

  const pageIds = new Set<string>();
  pages.forEach((page, index) => {
    if (pageIds.has(page.id)) throw new Failure('document.duplicate-id', ['pages', index, 'id']);
    if (Object.hasOwn(nodes, page.id))
      throw new Failure('document.duplicate-id', ['nodes', page.id]);
    pageIds.add(page.id);
  });

  // Every node sits in exactly one children list, the one its parent owns.
  const owner = new Map<string, string>();
  const claim = (ownerId: string, list: readonly string[], listPath: Path) => {
    list.forEach((child, index) => {
      if (!Object.hasOwn(nodes, child) || owner.has(child)) {
        throw new Failure('document.dangling-reference', [...listPath, index]);
      }
      owner.set(child, ownerId);
    });
  };
  pages.forEach((page, index) => claim(page.id, page.children, ['pages', index, 'children']));
  for (const [key, node] of entries) {
    if ('children' in node) claim(key, node.children, ['nodes', key, 'children']);
  }
  for (const [key, node] of entries) {
    if (!pageIds.has(node.parent) && !Object.hasOwn(nodes, node.parent)) {
      throw new Failure('document.dangling-reference', ['nodes', key, 'parent']);
    }
    if (owner.get(key) !== node.parent) {
      throw new Failure('document.dangling-reference', ['nodes', key, 'parent']);
    }
  }

  // Walk down from the pages: a node never reached is on a parent cycle. The walk is iterative
  // and bounds the container depth, so later tree algorithms are bounded too.
  const reached = new Set<string>();
  const stack: [string, number][] = [];
  for (const page of pages) for (const child of page.children) stack.push([child, 0]);
  while (stack.length > 0) {
    const [key, depth] = stack.pop()!;
    reached.add(key);
    const node = nodes[key]!;
    if (depth > MAX_TREE_DEPTH) invalid(['nodes', key, 'parent']);
    if ('children' in node) for (const child of node.children) stack.push([child, depth + 1]);
  }
  for (const [key] of entries) {
    if (!reached.has(key)) throw new Failure('document.cyclic-parent', ['nodes', key, 'parent']);
  }

  for (const [key, node] of entries) {
    if (node.type !== 'group' && node.type !== 'maskGroup') continue;
    if (node.children.length === 0) invalid(['nodes', key, 'children']);
    if (node.type === 'maskGroup' && nodes[node.children[0]!]!.type !== 'path') {
      throw new Failure('document.invalid-mask-source', ['nodes', key, 'children', 0]);
    }
  }
  return { schemaVersion: 2, id, pages, nodes };
}
