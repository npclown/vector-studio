import { MAX_DEPTH, scanJson } from './json-scan.js';
import type {
  Arrow,
  Color,
  Constraint,
  Constraints,
  DocumentV1,
  DocumentV2,
  DocumentV3,
  NodeV3,
  PageV3,
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
 * Section 3.3 codes, then the schema v2 and v3 codes. `unknown-custom-type` and
 * `invalid-custom-data` are checked by `editor-core` on load, never by the model.
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
  // Schema v3 (MVP M7 contract, section 2).
  'document.invalid-symbol',
] as const;

export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[number];

/** The codes the model itself returns. */
export type ModelErrorCode = Exclude<
  DocumentErrorCode,
  'document.unknown-custom-type' | 'document.invalid-custom-data'
>;

/** `path` is a JSON Pointer (RFC 6901) to the offending field; `''` is the whole document. */
export type ModelFailure = Readonly<{ ok: false; code: ModelErrorCode; path: string }>;

/** The latest schema version, which every validated document has (M7 contract, section 2). */
export type ParseResult = Readonly<{ ok: true; document: DocumentV3 }> | ModelFailure;

/** The result of `migrateV1toV2`, the first step of the migration chain. */
export type ParseResultV2 = Readonly<{ ok: true; document: DocumentV2 }> | ModelFailure;

/** The result of `validateFragmentTree`: a node map, never a document. */
export type FragmentTreeResult =
  Readonly<{ ok: true; nodes: Readonly<Record<string, NodeV3>> }> | ModelFailure;

export type NodeResult =
  | Readonly<{ ok: true; node: NodeV3 }>
  | Readonly<{ ok: false; code: 'document.invalid-field'; path: string }>;

/** Deepest container nesting of the node tree (ancestors that are containers). */
export const MAX_TREE_DEPTH = 256;

/**
 * IDs are opaque non-empty strings, unique across the document's pages and nodes, without
 * U+0000, which synthetic scene IDs use (M1-S4).
 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000');
}

/**
 * Parses JSON text of schema version 1, 2 or 3 into a validated v3 document (M1 contract, section
 * 2.1; M7 contract, section 2.1); older versions are migrated by `migrateV1toV2` and
 * `migrateV2toV3`. No partial document is ever returned.
 */
export function parseDocument(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'document.malformed-json', path: '' };
  }
  const version = checkVersion(value, [1, 2, 3]);
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
  return validateAnyDocument(value);
}

/**
 * Validates an in-memory v3 document value and returns a normalized copy: negative zero becomes
 * 0, rotations are normalized and nothing is shared with the input. A v1 or v2 value is
 * `document.unsupported-version`; `validateAnyDocument` accepts every version.
 */
export function validateDocument(value: unknown): ParseResult {
  const version = checkVersion(value, [3]);
  if (version !== null) return version;
  return guarded(() => readDocumentV3(value as Record<string, unknown>, V3_TYPES));
}

/**
 * Validates an in-memory v1, v2 or v3 value and returns a normalized v3 copy (older versions are
 * migrated).
 */
export function validateAnyDocument(value: unknown): ParseResult {
  const version = checkVersion(value, [1, 2, 3]);
  if (version !== null) return version;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 1) {
    let v1: DocumentV1;
    try {
      v1 = readDocumentV1(record);
    } catch (error) {
      if (error instanceof Failure) {
        return { ok: false, code: error.code, path: pointer(error.path) };
      }
      throw error;
    }
    const v2 = migrateV1toV2(v1);
    return v2.ok ? migrateV2toV3(v2.document) : v2;
  }
  // A v2 value is read once with the v2 node types; the v3 result differs only in its version.
  return guarded(() => readDocumentV3(record, record.schemaVersion === 2 ? V2_TYPES : V3_TYPES));
}

/**
 * The model's tree rules for a clipboard fragment (M7 contract, section 6), on a holder document
 * value of schema version 3 whose pages hold the fragment roots:
 * `{ schemaVersion: 3, id, pages: [{ id, name, children: roots }], nodes }`, exactly the four keys
 * of a document, with `id` and the page ID not keys of `nodes` and each root's `parent` the page
 * ID (the caller rewrites the fragment's `""`). It runs every rule of
 * `validateDocument` except two, which the fragment rules and the paste resolve instead: M7-S2
 * (each instance names a `symbol` of the same document) and M7-S5 (the tree depth through an
 * expansion). M7-S3 nesting and the base tree depth still run. Returns the normalized node map,
 * never a document; no document entry point skips these rules.
 */
export function validateFragmentTree(value: unknown): FragmentTreeResult {
  const version = checkVersion(value, [3]);
  if (version !== null) return version;
  try {
    const tree = readTree(value as Record<string, unknown>, V3_TYPES, false);
    return { ok: true, nodes: tree.nodes };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

/**
 * Validates one v3 node with the field rules of `validateDocument`, so commands reject the values
 * a load would reject. `path` is relative to the node; references are not checked here.
 */
export function validateNode(value: unknown): NodeResult {
  try {
    const id = isPlainObject(value) ? value.id : undefined;
    return { ok: true, node: readNodeV3(typeof id === 'string' ? id : '', value, [], V3_TYPES) };
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

function checkVersion(value: unknown, versions: readonly number[]): ModelFailure | null {
  if (!isPlainObject(value)) return { ok: false, code: 'document.invalid-field', path: '' };
  if (!versions.includes(value.schemaVersion as number)) {
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

/** A v1 ID: any non-empty string. U+0000 is rejected by the v2 rules after migration. */
function isValidIdV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readId(value: unknown, path: Path): string {
  if (!isValidIdV1(value)) invalid(path);
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

/** The v1 node reader, used only to migrate v1 input (M1 contract, section 2.1). */
function readNodeV1(key: string, value: unknown, path: Path): NodeV1 {
  if (!isPlainObject(value)) invalid(path);
  const type = readEnum(value.type, Object.keys(NODE_KEYS) as NodeType[], [...path, 'type']);
  const record = readRecord(value, NODE_KEYS[type], path);
  if (!isValidIdV1(key) || record.id !== key) invalid([...path, 'id']);
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

function readPageV1(value: unknown, path: Path): PageV1 {
  const record = readRecord(value, ['id', 'name', 'children'], path);
  const childrenPath = [...path, 'children'];
  return {
    id: readId(record.id, [...path, 'id']),
    name: readString(record.name, [...path, 'name']),
    children: readArray(record.children, childrenPath, readId),
  };
}

/** The v1 document reader: exactly one page, v1 nodes; input of `migrateV1toV2` only. */
function readDocumentV1(value: Record<string, unknown>): DocumentV1 {
  const record = readRecord(value, ['schemaVersion', 'id', 'pages', 'nodes'], []);
  const id = readId(record.id, ['id']);
  if (!Array.isArray(record.pages) || record.pages.length !== 1) invalid(['pages']);
  const page = readPageV1(record.pages[0], ['pages', 0]);
  if (!isPlainObject(record.nodes)) invalid(['nodes']);
  const entries = Object.entries(record.nodes).map(
    ([key, node]) => [key, readNodeV1(key, node, ['nodes', key])] as const,
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

// Schemas v2 and v3 (MVP M1 contract, section 2; M7 contract, section 2): the migrations and the
// v2 and v3 readers.

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
  try {
    const tree = readTree(
      {
        schemaVersion: 2,
        id: document.id,
        pages: document.pages.map((page) => ({ ...page, children: [...page.children] })),
        nodes,
      },
      V2_TYPES,
      true,
    );
    // Read with the v2 node types only, so every node is a v2 node.
    return { ok: true, document: { schemaVersion: 2, ...tree } as DocumentV2 };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

/**
 * Changes `schemaVersion` to 3 and nothing else, since no v2 node changes (M7 contract, section
 * 2.1, M7-Q12 (a)); the input is validated with the v2 rules, so it holds no v3 node type.
 */
export function migrateV2toV3(document: DocumentV2): ParseResult {
  return guarded(() => readDocumentV3({ ...document, schemaVersion: 3 }, V2_TYPES));
}

/** Normalizes radians to (−π, π], negative zero to 0 (contract M1-S1). */
export function normalizeRotation(theta: number): number {
  let t = theta - 2 * Math.PI * Math.round(theta / (2 * Math.PI));
  if (t <= -Math.PI) t += 2 * Math.PI;
  if (t > Math.PI) t -= 2 * Math.PI;
  return t === 0 ? 0 : t;
}

function guarded(read: () => DocumentV3): ParseResult {
  try {
    return { ok: true, document: read() };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

function readIdV2(value: unknown, path: Path): string {
  if (!isValidId(value)) invalid(path);
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
  // Schema v3 (M7 contract, section 2.1): a symbol's keys are a frame's, an instance's the base
  // keys followed by `symbol`.
  symbol: [...BASE_KEYS_V2, 'children', 'fill', 'stroke'],
  instance: [...BASE_KEYS_V2, 'symbol'],
} as const;
type NodeTypeKey = keyof typeof NODE_KEYS_V2;

/** The node types of each schema version; a v2 value with a v3 type fails at its `type`. */
const V3_TYPES = Object.keys(NODE_KEYS_V2) as NodeTypeKey[];
const V2_TYPES = V3_TYPES.filter((type) => type !== 'symbol' && type !== 'instance');

function isContainerType(type: string): boolean {
  return type === 'group' || type === 'maskGroup' || type === 'frame' || type === 'symbol';
}

function readNodeV3(
  key: string,
  value: unknown,
  path: Path,
  types: readonly NodeTypeKey[],
): NodeV3 {
  if (!isPlainObject(value)) invalid(path);
  const type = readEnum(value.type, types, [...path, 'type']);
  const record = readRecord(value, NODE_KEYS_V2[type], path);
  if (!isValidId(key) || record.id !== key) invalid([...path, 'id']);
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
  // Container opacity other than 1 waits for isolated composition (M1-S5); an instance projects
  // as a container, so it follows the same rule (M7-S4).
  if ((isContainerType(type) || type === 'instance') && base.opacity !== 1) {
    invalid([...path, 'opacity']);
  }
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
    case 'symbol':
      return {
        ...base,
        type,
        children: children(),
        fill: fill(),
        stroke: readNullable(record.stroke, [...path, 'stroke'], readRectStroke),
      };
    case 'instance':
      return { ...base, type, symbol: readIdV2(record.symbol, [...path, 'symbol']) };
  }
}

function readPageV3(value: unknown, path: Path): PageV3 {
  const record = readRecord(value, ['id', 'name', 'children'], path);
  return {
    id: readIdV2(record.id, [...path, 'id']),
    name: readString(record.name, [...path, 'name']),
    children: readArray(record.children, [...path, 'children'], (entry, entryPath) =>
      readIdV2(entry, entryPath),
    ),
  };
}

type Tree = Readonly<{ id: string; pages: PageV3[]; nodes: Record<string, NodeV3> }>;

/** A v3 document read with the node types of its source version (`V2_TYPES` when migrating). */
function readDocumentV3(value: Record<string, unknown>, types: readonly NodeTypeKey[]): DocumentV3 {
  return { schemaVersion: 3, ...readTree(value, types, true) };
}

/**
 * The document rules in the M7 contract's section 2 order: fields, ownership, M7-S2, the cycle
 * walk with the base tree depth, M7-S3, the M7-S5 tree depth, then the group and mask rules.
 * `references` false skips only M7-S2 and M7-S5, for `validateFragmentTree`.
 */
function readTree(
  value: Record<string, unknown>,
  types: readonly NodeTypeKey[],
  references: boolean,
): Tree {
  const record = readRecord(value, ['schemaVersion', 'id', 'pages', 'nodes'], []);
  const id = readIdV2(record.id, ['id']);
  if (!Array.isArray(record.pages) || record.pages.length === 0) invalid(['pages']);
  const pages = readArray(record.pages, ['pages'], readPageV3);
  if (!isPlainObject(record.nodes)) invalid(['nodes']);
  const entries = Object.entries(record.nodes).map(
    ([key, node]) => [key, readNodeV3(key, node, ['nodes', key], types)] as const,
  );
  const nodes: Record<string, NodeV3> = Object.fromEntries(entries);

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

  // M7-S2: an instance names a symbol of this document, on any page.
  if (references) {
    for (const [key, node] of entries) {
      if (node.type !== 'instance') continue;
      const target = Object.hasOwn(nodes, node.symbol) ? nodes[node.symbol]! : undefined;
      if (target === undefined) {
        throw new Failure('document.dangling-reference', ['nodes', key, 'symbol']);
      }
      if (target.type !== 'symbol') {
        throw new Failure('document.invalid-symbol', ['nodes', key, 'symbol']);
      }
    }
  }

  // Walk down from the pages: a node never reached is on a parent cycle. The walk is iterative
  // and bounds the container depth, so later tree algorithms are bounded too. It also records
  // each node's depth and its innermost symbol ancestor, for M7-S3 and M7-S5.
  const reached = new Set<string>();
  const depthOf = new Map<string, number>();
  const symbolAbove = new Map<string, string>();
  const stack: [string, number, string | null][] = [];
  for (const page of pages) for (const child of page.children) stack.push([child, 0, null]);
  while (stack.length > 0) {
    const [key, depth, above] = stack.pop()!;
    reached.add(key);
    depthOf.set(key, depth);
    if (above !== null) symbolAbove.set(key, above);
    const node = nodes[key]!;
    if (depth > MAX_TREE_DEPTH) invalid(['nodes', key, 'parent']);
    if ('children' in node) {
      const inner = node.type === 'symbol' ? key : above;
      for (const child of node.children) stack.push([child, depth + 1, inner]);
    }
  }
  for (const [key] of entries) {
    if (!reached.has(key)) throw new Failure('document.cyclic-parent', ['nodes', key, 'parent']);
  }

  // M7-S3: no instance and no symbol inside a symbol.
  for (const [key, node] of entries) {
    if ((node.type === 'instance' || node.type === 'symbol') && symbolAbove.has(key)) {
      throw new Failure('document.invalid-symbol', ['nodes', key, 'parent']);
    }
  }

  // M7-S5 tree depth: an expanded node sits at the instance's depth plus its depth below the
  // source, so the deepest one is the instance's depth plus the source subtree's height. After
  // M7-S3 no symbol is inside another, so each node has at most one symbol ancestor.
  if (references) {
    const height = new Map<string, number>();
    for (const [key, source] of symbolAbove) {
      const below = depthOf.get(key)! - depthOf.get(source)!;
      if (below > (height.get(source) ?? 0)) height.set(source, below);
    }
    for (const [key, node] of entries) {
      if (node.type !== 'instance') continue;
      if (depthOf.get(key)! + (height.get(node.symbol) ?? 0) > MAX_TREE_DEPTH) {
        invalid(['nodes', key, 'parent']);
      }
    }
  }

  for (const [key, node] of entries) {
    if (node.type !== 'group' && node.type !== 'maskGroup') continue;
    if (node.children.length === 0) invalid(['nodes', key, 'children']);
    if (node.type === 'maskGroup' && nodes[node.children[0]!]!.type !== 'path') {
      throw new Failure('document.invalid-mask-source', ['nodes', key, 'children', 0]);
    }
  }
  return { id, pages, nodes };
}
