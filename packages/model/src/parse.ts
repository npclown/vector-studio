import { MAX_DEPTH, scanJson } from './json-scan.js';
import {
  BINDING_KEYS,
  MAX_COLOR_STYLES,
  MAX_TABLE_NAME_LENGTH,
  MAX_VARIABLE_MODES,
  MAX_VARIABLES,
  bindingHolds,
  bindingKeyAllowed,
  bindingTarget,
  type BindingTables,
} from './bindings.js';
import type {
  AutoLayout,
  AxisSizing,
  LayoutFields,
  Arrow,
  BindingKey,
  BindingRef,
  Bindings,
  BlendMode,
  Color,
  ColorStyle,
  ContainerBlendMode,
  Variable,
  VariableSet,
  Constraint,
  Constraints,
  DocumentV1,
  DocumentV2,
  DocumentV3,
  DocumentV4,
  DocumentV5,
  DocumentV6,
  DocumentV7,
  DocumentV8,
  BandLayoutGrid,
  Effect,
  Fill,
  Guide,
  LayoutGrid,
  NodeV6,
  NodeV8,
  PageV8,
  Dash,
  FillRule,
  Frame,
  Gradient,
  GradientStop,
  JsonValue,
  NodeV1,
  Paint,
  PageV1,
  PathData,
  PathStroke,
  PathVerb,
  RectStroke,
  Stroke,
  StrokeCap,
  StrokeJoin,
  TextNode,
  TextOverride,
  TextRun,
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

/** The latest schema version, 8, which every validated document has (docs/plans/viz-schema-v8.md). */
export type ParseResult = Readonly<{ ok: true; document: DocumentV8 }> | ModelFailure;

/** The result of `migrateV5toV6`, the fifth step of the migration chain. */
export type ParseResultV6 = Readonly<{ ok: true; document: DocumentV6 }> | ModelFailure;
/** A migration step's v7 result. */
export type ParseResultV7 = Readonly<{ ok: true; document: DocumentV7 }> | ModelFailure;

/** The result of `migrateV1toV2`, the first step of the migration chain. */
export type ParseResultV2 = Readonly<{ ok: true; document: DocumentV2 }> | ModelFailure;

/** The result of `migrateV2toV3`, the second step of the migration chain. */
export type ParseResultV3 = Readonly<{ ok: true; document: DocumentV3 }> | ModelFailure;

/** The result of `migrateV3toV4`, the third step of the migration chain. */
export type ParseResultV4 = Readonly<{ ok: true; document: DocumentV4 }> | ModelFailure;

/** The result of `migrateV4toV5`, the fourth step of the migration chain. */
export type ParseResultV5 = Readonly<{ ok: true; document: DocumentV5 }> | ModelFailure;

/** The result of `validateFragmentTree`: a node map, never a document. */
export type FragmentTreeResult =
  Readonly<{ ok: true; nodes: Readonly<Record<string, NodeV8>> }> | ModelFailure;

export type NodeResult =
  | Readonly<{ ok: true; node: NodeV8 }>
  | Readonly<{ ok: false; code: 'document.invalid-field'; path: string }>;

/** Deepest container nesting of the node tree (ancestors that are containers). */
export const MAX_TREE_DEPTH = 256;

/** The most UTF-16 units of one text node's runs together (M6a-S4). */
export const MAX_TEXT_LENGTH = 16_384;

/** The most stops of one gradient (M4-S2); mirrors the contracts `SCENE_MAX_GRADIENT_STOPS`. */
export const MAX_GRADIENT_STOPS = 16;

/** The most entries of one dash pattern (M4-S4); mirrors the contracts `SCENE_MAX_DASH_ENTRIES`. */
export const MAX_DASH_ENTRIES = 16;

/** The most effects of one node (E41-S3), at most one of them a layer blur. */
export const MAX_EFFECTS = 8;
/** V35-S3: the most fills a node holds. */
export const MAX_FILLS = 16;

/** The largest effect radius, and the largest shadow offset magnitude (E41-S3). */
export const MAX_EFFECT_RADIUS = 1000;
export const MAX_EFFECT_OFFSET = 10_000;

/** The most guides of one page, and the largest guide value magnitude (V38-S1). */
export const MAX_GUIDES = 1000;
export const MAX_GUIDE_VALUE = 1e7;

/** The most layout grids of one frame or symbol (V38-S2), and their number bounds. */
export const MAX_LAYOUT_GRIDS = 16;
export const MAX_GRID_SIZE = 1e4;
export const MAX_GRID_COUNT = 1000;
export const MAX_GRID_VALUE = 1e7;

/**
 * IDs are opaque non-empty strings, unique across the document's pages and nodes, without
 * U+0000, which synthetic scene IDs use (M1-S4).
 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000');
}

/**
 * Parses JSON text of schema version 1 to 8 into a validated v8 document (M1 contract, section
 * 2.1; M7 contract, section 2.1; M6a contract, sections 2.1 and 9; M4 contract, section 2.1; E41
 * contract, section 3); older versions are migrated by `migrateV1toV2` to `migrateV7toV8`. No
 * partial document is ever returned.
 */
export function parseDocument(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'document.malformed-json', path: '' };
  }
  const version = checkVersion(value, [1, 2, 3, 4, 5, 6, 7, 8]);
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
 * Validates an in-memory v8 document value and returns a normalized copy: negative zero becomes
 * 0, rotations are normalized, text override keys are in code unit order and nothing is shared
 * with the input. A v1 to v7 value is `document.unsupported-version`; `validateAnyDocument`
 * accepts every version.
 */
export function validateDocument(value: unknown): ParseResult {
  const version = checkVersion(value, [8]);
  if (version !== null) return version;
  return guarded(() => readDocumentV8(value as Record<string, unknown>, V8));
}

/**
 * Validates an in-memory v1 to v8 value and returns a normalized v8 copy (older versions are
 * migrated).
 */
export function validateAnyDocument(value: unknown): ParseResult {
  const version = checkVersion(value, [1, 2, 3, 4, 5, 6, 7, 8]);
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
    if (!v2.ok) return v2;
    const v3 = migrateV2toV3(v2.document);
    if (!v3.ok) return v3;
    const v4 = migrateV3toV4(v3.document);
    if (!v4.ok) return v4;
    const v5 = migrateV4toV5(v4.document);
    if (!v5.ok) return v5;
    const v6 = migrateV5toV6(v5.document);
    if (!v6.ok) return v6;
    const v7 = migrateV6toV7(v6.document);
    return v7.ok ? migrateV7toV8(v7.document) : v7;
  }
  // A v2 to v7 value is read once with its version's node types; the v8 result differs only in
  // its version, the empty `textOverrides` of every instance below v5 (`migrateV4toV5`), the
  // v6 strokes (`migrateV5toV6`) and the empty `effects` of every node (`migrateV6toV7`).
  const schema =
    record.schemaVersion === 2
      ? V2_TO_V7
      : record.schemaVersion === 3
        ? V3_TO_V7
        : record.schemaVersion === 4
          ? V4_TO_V7
          : record.schemaVersion === 5
            ? V5_TO_V7
            : record.schemaVersion === 6
              ? V6_TO_V7
              : record.schemaVersion === 7
                ? V7_TO_V8
                : V8;
  return guarded(() => readDocumentV8(record, schema));
}

/**
 * The model's tree rules for a clipboard fragment (M7 contract, section 6), on a holder document
 * value of the latest schema version, 8, whose pages hold the fragment
 * roots: `{ schemaVersion: 8, id, pages: [{ id, name, children: roots }], nodes }`, exactly the
 * four keys of a document, with `id` and the page ID not keys of `nodes` and each root's `parent`
 * the page ID (the caller rewrites the fragment's `""`). It runs every rule of `validateDocument`
 * except two, which the fragment rules and the paste resolve instead: M7-S2 (each instance names
 * a `symbol` of the same document, and with it the M7-T3 rule that each text override key names a
 * text node of the instance's source) and M7-S5 (the tree depth through an expansion). M7-S3
 * nesting and the base tree depth still run. Returns the normalized node map, never a document;
 * no document entry point skips these rules.
 */
export function validateFragmentTree(value: unknown): FragmentTreeResult {
  const version = checkVersion(value, [8]);
  if (version !== null) return version;
  try {
    const tree = readTree(value as Record<string, unknown>, V8, false);
    return { ok: true, nodes: tree.nodes };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

/**
 * A paint by the model's rules (M4-S1, S2), normalized, or null (V-39: a style's paint and a
 * colour variable's value, which commands check before they write them).
 */
export function validatePaint(value: unknown): Paint | null {
  try {
    return readPaint(value, []);
  } catch (error) {
    if (error instanceof Failure) return null;
    throw error;
  }
}

/** Options of `validateNode`. */
export type ValidateNodeOptions = Readonly<{
  /**
   * The node comes from an input below v6 (an older clipboard fragment), already given the v8
   * fields: a container or instance opacity other than 1 fails at `/opacity`, in the field order
   * of an older document (M4 contract, M4-M2 and section 7).
   */
  olderInput?: boolean;
}>;

/**
 * Validates one v8 node with the field rules of `validateDocument`, so commands reject the values
 * a load would reject. `path` is relative to the node; references (M7-S2 and the M7-T3 override
 * keys among them) are not checked here.
 */
export function validateNode(value: unknown, options: ValidateNodeOptions = {}): NodeResult {
  const schema = options.olderInput === true ? V8_OLDER_OPACITY : V8;
  try {
    const id = isPlainObject(value) ? value.id : undefined;
    return { ok: true, node: readNode(typeof id === 'string' ? id : '', value, [], schema) };
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

// Schemas v2 to v6 (MVP M1 contract, section 2; M7 contract, section 2; M6a contract, sections 2
// and 9; M4 contract, section 2): the migrations and the v2 to v6 readers.

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
      V2,
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
export function migrateV2toV3(document: DocumentV2): ParseResultV3 {
  try {
    // Read with the v2 node types only, so every node is a v3 node without a text node.
    const tree = readTree({ ...document, schemaVersion: 3 }, V2, true);
    return { ok: true, document: { schemaVersion: 3, ...tree } as DocumentV3 };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

/**
 * Changes `schemaVersion` to 4 and nothing else, since no v3 node changes (M6a contract, section
 * 2.1); the input is validated with the v3 rules, so it holds no `text` node.
 */
export function migrateV3toV4(document: DocumentV3): ParseResultV4 {
  try {
    // Read with the v3 node types only, so every node is a v4 node without a text node.
    const tree = readTree({ ...document, schemaVersion: 4 }, V3, true);
    return { ok: true, document: { schemaVersion: 4, ...tree } as DocumentV4 };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

/**
 * Changes `schemaVersion` to 5 and adds `textOverrides: {}` to every instance, and nothing else
 * (M6a contract, section 9, M7-T3, M7-Q11 (a)); the input is validated with the v4 rules, so an
 * instance holding `textOverrides` fails at that key.
 */
export function migrateV4toV5(document: DocumentV4): ParseResultV5 {
  return guarded(() => ({
    schemaVersion: 5,
    // Read with the v4 node types and strokes, so every node is a v5 node.
    ...(readTree({ ...document, schemaVersion: 5 }, V4_TO_V5, true) as Tree<DocumentV5>),
  }));
}

/**
 * Changes `schemaVersion` to 6 and rewrites every stroke, and nothing else (M4 contract, section
 * 2.1, M4-M1): a `{ color, width }` stroke of a rectangle, ellipse, frame or symbol becomes
 * `{ color, width, cap: 'butt', join: 'round', miterLimit: 4, dash: null }`, and a line, path or
 * custom stroke gains `dash: null`. The input is validated with the v5 rules, so a v6 stroke or
 * a gradient in it fails at its first v6 key, and a container or instance opacity other than 1
 * still fails (M4-M2).
 */
export function migrateV5toV6(document: DocumentV5): ParseResultV6 {
  return guarded(() => ({
    schemaVersion: 6,
    ...(readTree({ ...document, schemaVersion: 6 }, V5_TO_V6, true) as unknown as Tree<DocumentV6>),
  }));
}

/**
 * Changes `schemaVersion` to 7 and adds `effects: []` to every node, and nothing else (E41
 * contract, E41-S1).
 */
export function migrateV6toV7(document: DocumentV6): ParseResultV7 {
  return guarded(() => ({
    schemaVersion: 7,
    ...(readTree(
      { ...document, schemaVersion: 7 },
      V6_TO_V7_ONLY,
      true,
    ) as unknown as Tree<DocumentV7>),
  }));
}

/**
 * Changes `schemaVersion` to 8, and nothing else while v8 has v7's shape (the gap-list items
 * V-31 to V-40 each add their fields and defaults here).
 */
export function migrateV7toV8(document: DocumentV7): ParseResult {
  return guarded(() => readDocumentV8({ ...document, schemaVersion: 8 }, V7_TO_V8));
}

/** Normalizes radians to (−π, π], negative zero to 0 (contract M1-S1). */
export function normalizeRotation(theta: number): number {
  let t = theta - 2 * Math.PI * Math.round(theta / (2 * Math.PI));
  if (t <= -Math.PI) t += 2 * Math.PI;
  if (t > Math.PI) t -= 2 * Math.PI;
  return t === 0 ? 0 : t;
}

function guarded<D>(read: () => D): Readonly<{ ok: true; document: D }> | ModelFailure {
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
  // Schema v4 (M6a contract, section 2).
  text: [...BASE_KEYS_V2, 'runs', 'sizing', 'align', 'letterSpacing', 'lineHeight'],
} as const;
type NodeTypeKey = keyof typeof NODE_KEYS_V2;
/** Schema v5 (M6a contract, section 9, M7-T3): `textOverrides` follows `symbol`. */
const INSTANCE_KEYS_V5 = [...NODE_KEYS_V2.instance, 'textOverrides'] as const;

/**
 * How one read treats its input: the node types of its schema version (a value with a type of a
 * later version fails at its `type`); the instance's `textOverrides` (M7-T3): `none` before v5
 * (the key is unknown and none is added), `added` when an older input is read into v5 or later
 * (the key is unknown and an empty one is added, as `migrateV4toV5` does), `read` from v5; and
 * the appearance fields (M4 contract, section 2): `none` before v6 (fills are colours, strokes the
 * v5 `RectStroke` and `PathStroke`), `added` when an older input is read into v6 (read as before
 * v6, then each stroke rewritten as `migrateV5toV6` does, M4-M1), `read` at v6 (paints and the
 * one `Stroke`, M4-S1 to S4).
 */
type Schema = Readonly<{
  types: readonly NodeTypeKey[];
  overrides: 'none' | 'added' | 'read';
  appearance: 'none' | 'added' | 'read';
  /**
   * The opacity of a container or instance: `one` below v6 (M1-S5, M7-S4, kept for older inputs
   * by M4-M2), `any` at v6 (M4-L1), where M4-S5's `[0, 1]` applies as to every node.
   */
  containerOpacity: 'one' | 'any';
  /**
   * The node's `effects` (E41 contract, section 3): `none` before v7 (the key is unknown and none
   * is added), `added` when an older input is read into v7 (`[]`, as `migrateV6toV7` does),
   * `read` at v7 (E41-S2, S3).
   */
  effects: 'none' | 'added' | 'read';
  /** The effect kinds `read` accepts: E41's at v7, V-36's too at v8 (V36-S2). */
  effectKinds: 'v7' | 'v8';
  /**
   * V-39 (V39-S1 to S6): `read` reads a node's optional `bindings` and a document's optional
   * `colorStyles` and `variables`; absent (every older input) means none, which is their default.
   */
  tables?: 'read';
  /**
   * The node's `fills` and `blendMode` (V-35 contract, V35-S1): `none` before v8 (a node has
   * v6's `fill`), `added` when an older input is read into v8 (`fill` becomes `fills`, the default
   * `blendMode` is added, as `migrateV7toV8` does), `read` at v8 (V35-S2, S3, with the unreleased
   * v8's legacy `fill`).
   */
  fills: 'none' | 'added' | 'read';
  /**
   * The node's optional `locked` (V-31 contract, V31-S1): `read` at v8 only. Its default is no
   * key (unlocked), so `added` (an older input read into v8) and `none` both add nothing and a
   * `locked` key in an older input fails as unknown.
   */
  locked: 'none' | 'added' | 'read';
  /**
   * The optional page `guides` and frame or symbol `layoutGrids` (V-38 contract, V38-S1, S2):
   * read only at v8 (`V8`); every schema that reads an older input leaves it unset, so there the
   * keys are unknown and their default (absent, no guides or grids) is what the v8 result holds.
   */
  layout?: 'read';
  /**
   * V-34's optional `autoLayout` and `layoutSizing` (contract, section 2; viz-schema-v8.md): read
   * only at v8 (`V8`). Every schema that reads an older input leaves it unset, so there the keys
   * are unknown and their default (absent: no auto layout, fixed sizing) is what the v8 result
   * holds.
   */
  autoLayout?: 'read';
}>;

const V4_TYPES = Object.keys(NODE_KEYS_V2) as NodeTypeKey[];
const V3_TYPES = V4_TYPES.filter((type) => type !== 'text');
const V2_TYPES = V3_TYPES.filter((type) => type !== 'symbol' && type !== 'instance');
const OLDER = { containerOpacity: 'one' } as const;
const NO_EFFECTS = { effects: 'none', effectKinds: 'v7', fills: 'none', locked: 'none' } as const;
const ADD_EFFECTS = {
  effects: 'added',
  effectKinds: 'v7',
  fills: 'added',
  locked: 'added',
} as const;
const V2: Schema = {
  types: V2_TYPES,
  overrides: 'none',
  appearance: 'none',
  ...OLDER,
  ...NO_EFFECTS,
};
const V3: Schema = { ...V2, types: V3_TYPES };
const V4_TO_V5: Schema = { ...V2, types: V4_TYPES, overrides: 'added' };
const V5_TO_V6: Schema = {
  types: V4_TYPES,
  overrides: 'read',
  appearance: 'added',
  ...OLDER,
  ...NO_EFFECTS,
};
const V2_TO_V7: Schema = {
  types: V2_TYPES,
  overrides: 'added',
  appearance: 'added',
  ...OLDER,
  ...ADD_EFFECTS,
};
const V3_TO_V7: Schema = { ...V2_TO_V7, types: V3_TYPES };
const V4_TO_V7: Schema = { ...V2_TO_V7, types: V4_TYPES };
const V5_TO_V7: Schema = { ...V4_TO_V7, overrides: 'read' };
const V6_TO_V7: Schema = {
  types: V4_TYPES,
  overrides: 'read',
  appearance: 'read',
  containerOpacity: 'any',
  ...ADD_EFFECTS,
};
/** `migrateV6toV7` only: a v7 result keeps v6's `fill`. */
const V6_TO_V7_ONLY: Schema = { ...V6_TO_V7, fills: 'none' };
/**
 * A v7 input read into v8 (V35-S1, V31-S1): v7's fields and effect kinds. V8 adds V-36's effect
 * kinds and the V-38 `layout` keys, which every schema that reads an older input leaves unset, so
 * their default (absent) is what that input gets. An item adding a v8 field adds its dimension to
 * every schema that reads into v8 (`V2_TO_V7` to `V6_TO_V7` too, which `validateAnyDocument` uses
 * for older inputs); see docs/plans/viz-schema-v8.md, Where a field addition goes.
 */
const V7: Schema = { ...V6_TO_V7, effects: 'read' };
const V7_TO_V8: Schema = { ...V7, fills: 'added', locked: 'added' };
const V8: Schema = {
  ...V7,
  effectKinds: 'v8',
  fills: 'read',
  locked: 'read',
  layout: 'read',
  tables: 'read',
  autoLayout: 'read',
};
/** v8 nodes of an input below v6, already migrated: v8 fields, the older opacity rule. */
const V8_OLDER_OPACITY: Schema = { ...V8, ...OLDER };

const GRADIENT_KINDS: readonly Gradient['kind'][] = ['linear', 'radial'];
const SPREADS: readonly Gradient['spread'][] = ['pad', 'reflect', 'repeat'];
const COLOR_KEYS = ['r', 'g', 'b', 'a'] as const;
const GRADIENT_KEYS = ['kind', 'transform', 'stops', 'spread'] as const;

/** Whether `value` is a plain object with exactly `keys`, in any order. */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * M4-S1: exactly `r, g, b, a` is a colour, exactly `kind, transform, stops, spread` a gradient;
 * anything else fails at the paint's own path.
 */
function readPaint(value: unknown, path: Path): Paint {
  if (hasExactKeys(value, COLOR_KEYS)) return readColor(value, path);
  if (hasExactKeys(value, GRADIENT_KEYS)) return readGradient(value, path);
  invalid(path);
}

/**
 * M4-S2, mirroring E23-S2, in key order: `kind`; `transform` (six finite numbers, then the
 * binary64 determinant finite and non-zero and the binary64 inverse finite, at `transform`);
 * `stops` (1 to MAX_GRADIENT_STOPS entries at `stops`, then each `{ offset, color }` in order, an
 * offset in `[0, 1]` and not below the previous one); `spread`.
 */
function readGradient(record: Record<string, unknown>, path: Path): Gradient {
  const kind = readEnum(record.kind, GRADIENT_KINDS, [...path, 'kind']);
  const transformPath = [...path, 'transform'];
  if (!Array.isArray(record.transform) || record.transform.length !== 6) invalid(transformPath);
  const t = readArray(record.transform, transformPath, (entry, entryPath) =>
    readNumber(entry, entryPath),
  );
  const [a, b, c, d, e, f] = [t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!];
  const determinant = a * d - b * c;
  if (determinant === 0 || !Number.isFinite(determinant)) invalid(transformPath);
  const inverse = [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
  if (!inverse.every(Number.isFinite)) invalid(transformPath);
  const stopsPath = [...path, 'stops'];
  if (
    !Array.isArray(record.stops) ||
    record.stops.length === 0 ||
    record.stops.length > MAX_GRADIENT_STOPS
  ) {
    invalid(stopsPath);
  }
  let previous = 0;
  const stops = readArray(record.stops, stopsPath, (entry, entryPath): GradientStop => {
    const stop = readRecord(entry, ['offset', 'color'], entryPath);
    const offset = readNumber(stop.offset, [...entryPath, 'offset'], previous, 1);
    previous = offset;
    return { offset, color: readColor(stop.color, [...entryPath, 'color']) };
  });
  const spread = readEnum(record.spread, SPREADS, [...path, 'spread']);
  return { kind, transform: [a, b, c, d, e, f], stops, spread };
}

/**
 * M4-S4, mirroring E24-S1: `pattern` holds 1 to MAX_DASH_ENTRIES entries (at `pattern`), each
 * finite and at least 0 (at its index), at least one above 0 and a finite binary64 period summed
 * left to right, doubled for an odd count (at `pattern`); `phase` finite.
 */
function readDash(value: unknown, path: Path): Dash {
  const record = readRecord(value, ['pattern', 'phase'], path);
  const patternPath = [...path, 'pattern'];
  if (
    !Array.isArray(record.pattern) ||
    record.pattern.length === 0 ||
    record.pattern.length > MAX_DASH_ENTRIES
  ) {
    invalid(patternPath);
  }
  const pattern = readArray(record.pattern, patternPath, (entry, entryPath) =>
    readNumber(entry, entryPath, 0),
  );
  let period = 0;
  for (const entry of pattern) period += entry;
  if (pattern.length % 2 === 1) for (const entry of pattern) period += entry;
  if (!pattern.some((entry) => entry > 0) || !Number.isFinite(period)) invalid(patternPath);
  return { pattern, phase: readNumber(record.phase, [...path, 'phase']) };
}

/** M4-S3: the one v6 stroke, in the key order `color, width, cap, join, miterLimit, dash`. */
function readStroke(value: unknown, path: Path): Stroke {
  const record = readRecord(value, ['color', 'width', 'cap', 'join', 'miterLimit', 'dash'], path);
  return {
    color: readPaint(record.color, [...path, 'color']),
    width: readNumber(record.width, [...path, 'width'], 0),
    cap: readEnum(record.cap, CAPS, [...path, 'cap']),
    join: readEnum(record.join, JOINS, [...path, 'join']),
    miterLimit: readNumber(record.miterLimit, [...path, 'miterLimit'], 1),
    dash: readNullable(record.dash, [...path, 'dash'], readDash),
  };
}

type Readers = Readonly<{
  shape: (value: unknown, path: Path) => Stroke | RectStroke;
  path: (value: unknown, path: Path) => Stroke | PathStroke;
  fill: (value: unknown, path: Path) => Paint;
}>;

/** The fill and stroke readers at v6: paints and the one stroke (M4-S1 to S4). */
const READ_V6: Readers = { shape: readStroke, path: readStroke, fill: readPaint };
/** Before v6: colours and the v5 `RectStroke` and `PathStroke`. */
const READ_V5: Readers = { shape: readRectStroke, path: readPathStroke, fill: readColor };
/** The v5 readers, each stroke given the keys `migrateV5toV6` adds (M4-M1). */
const READ_V5_TO_V6: Readers = {
  shape: (value, path) => ({
    ...readRectStroke(value, path),
    cap: 'butt',
    join: 'round',
    miterLimit: 4,
    dash: null,
  }),
  path: (value, path) => ({ ...readPathStroke(value, path), dash: null }),
  fill: readColor,
};

/** The fill and stroke readers of one schema. */
function strokeReaders(schema: Schema): Readers {
  if (schema.appearance === 'read') return READ_V6;
  return schema.appearance === 'none' ? READ_V5 : READ_V5_TO_V6;
}

function isContainerType(type: string): boolean {
  return type === 'group' || type === 'maskGroup' || type === 'frame' || type === 'symbol';
}

const SIZINGS: readonly TextNode['sizing'][] = ['autoWidth', 'autoHeight', 'fixed'];
const ALIGNS: readonly TextNode['align'][] = ['left', 'center', 'right'];

/** A C0 or C1 control (DEL, U+007F, is neither). */
function isControl(unit: number): boolean {
  return unit <= 0x1f || (unit >= 0x80 && unit <= 0x9f);
}

/** The index of the first lone surrogate of `text`, or -1. */
function loneSurrogate(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else return i;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return i;
    }
  }
  return -1;
}

/**
 * Whether M6a-S1 rejects the UTF-16 code unit `unit` in run text on its own: a control other
 * than LF, a line or paragraph separator, or a bidi control. Surrogates are not judged here,
 * since only a lone one is rejected (`isValidRunText`).
 */
export function isRejectedRunTextUnit(unit: number): boolean {
  if (unit === 0x0a) return false;
  if (isControl(unit)) return true;
  if (unit === 0x2028 || unit === 0x2029) return true;
  if (unit === 0x200e || unit === 0x200f || unit === 0x061c) return true;
  return (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2066 && unit <= 0x2069);
}

/**
 * M6a-S1: LF is the only control; no line or paragraph separator, no bidi control and no lone
 * surrogate.
 */
export function isValidRunText(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (isRejectedRunTextUnit(text.charCodeAt(i))) return false;
  }
  return loneSurrogate(text) === -1;
}

/** M6a-S3: one family name of 1 to 128 UTF-16 units, without a control or a lone surrogate. */
function readFamily(value: unknown, path: Path): string {
  const family = readString(value, path);
  if (family.length === 0 || family.length > 128) invalid(path);
  for (let i = 0; i < family.length; i += 1) if (isControl(family.charCodeAt(i))) invalid(path);
  if (loneSurrogate(family) !== -1) invalid(path);
  return family;
}

function readRun(value: unknown, path: Path): TextRun {
  const record = readRecord(value, ['text', 'family', 'size', 'color'], path);
  const text = readString(record.text, [...path, 'text']);
  const family = readFamily(record.family, [...path, 'family']);
  const size = readNumber(record.size, [...path, 'size'], 0, 4096);
  if (size === 0) invalid([...path, 'size']);
  return { text, family, size, color: readColor(record.color, [...path, 'color']) };
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.color.r === b.color.r &&
    a.color.g === b.color.g &&
    a.color.b === b.color.b &&
    a.color.a === b.color.a
  );
}

/**
 * A text node's runs in the M6a contract's section 2 order: the array shape, each run's fields,
 * M6a-S4 over the whole node, the M6a-S1 scan run by run, then M6a-S2 run by run.
 */
function readRuns(value: unknown, path: Path): TextRun[] {
  if (!Array.isArray(value) || value.length === 0) invalid(path);
  const runs = readArray(value, path, readRun);
  let length = 0;
  for (const run of runs) length += run.text.length;
  if (length > MAX_TEXT_LENGTH) invalid(path);
  runs.forEach((run, index) => {
    if (!isValidRunText(run.text)) invalid([...path, index, 'text']);
  });
  runs.forEach((run, index) => {
    if (run.text.length === 0 && runs.length > 1) invalid([...path, index]);
    if (index > 0 && sameStyle(runs[index - 1]!, run)) invalid([...path, index]);
  });
  return runs;
}

/**
 * M7-T3: an override map, each value exactly `{ runs }` with runs as a text node's (M6a-S1 to S4),
 * read in UTF-16 code unit order of the keys and returned in that order. Whether each key names a
 * text node of the instance's source is a tree rule (`readTree`).
 */
function readOverrides(value: unknown, path: Path): Record<string, TextOverride> {
  if (!isPlainObject(value)) invalid(path);
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // fromEntries defines own properties, so a "__proto__" key stays data.
  return Object.fromEntries(
    keys.map((key) => {
      const record = readRecord(value[key], ['runs'], [...path, key]);
      return [key, { runs: readRuns(record.runs, [...path, key, 'runs']) }];
    }),
  );
}

/**
 * One node of any schema from v2 on, read with `schema`; the result is a v6 node when
 * `schema.appearance` is not `none`, else typed by the caller's version.
 */
function readNode(key: string, value: unknown, path: Path, schema: Schema): NodeV8 {
  // V39-S4: an optional `bindings`, read after the node's own fields.
  let raw = value;
  let bindings: unknown;
  const hasBindings =
    schema.tables === 'read' && isPlainObject(value) && Object.hasOwn(value, 'bindings');
  if (hasBindings) {
    const { bindings: own, ...rest } = value;
    raw = rest;
    bindings = own;
  }
  // V-34 (contract, section 2): v8's optional `autoLayout` and `layoutSizing`, read apart from the
  // node's own fields and checked last (V34-S1 to S3).
  let autoLayout: unknown;
  let layoutSizing: unknown;
  const layoutKeys = schema.autoLayout === 'read' && isPlainObject(raw);
  if (layoutKeys) {
    const { autoLayout: own, layoutSizing: sizing, ...rest } = raw as Record<string, unknown>;
    raw = rest;
    autoLayout = own;
    layoutSizing = sizing;
  }
  const legacy = schema.fills === 'read' ? readFillsShim(raw, path) : null;
  const node = readNodeFields(key, legacy === null ? raw : legacy.shim, path, schema);
  if (schema.effects === 'none') return node as unknown as NodeV8;
  const record = raw as Record<string, unknown>;
  const effects =
    schema.effects === 'read'
      ? readEffects(
          record.effects,
          [...path, 'effects'],
          schema.effectKinds === 'v8' ? EFFECT_KINDS_V8 : EFFECT_KINDS_V7,
        )
      : [];
  if (schema.fills === 'none') return { ...node, effects } as unknown as NodeV8;
  // `fills` takes `fill`'s place, so the value's key order is the written one (V35-S2).
  const withFills: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(node)) {
    if (key !== 'fill') {
      withFills[key] = field;
      continue;
    }
    const fill = field as Paint | null;
    withFills.fills =
      legacy !== null && legacy.fills
        ? readFills(record.fills, [...path, 'fills'])
        : fill === null
          ? []
          : [defaultFill(fill)];
  }
  const blendMode =
    legacy !== null && legacy.blend
      ? readBlendMode(record.blendMode, node.type, [...path, 'blendMode'])
      : defaultBlendMode(node.type);
  // V31-S1: absent or `false` is unlocked and normalizes to no key.
  const lock =
    schema.locked === 'read' &&
    Object.hasOwn(record, 'locked') &&
    readBoolean(record.locked, [...path, 'locked'])
      ? { locked: true as const }
      : {};
  const result = { ...withFills, blendMode, effects, ...lock };
  const bound = (hasBindings
    ? { ...result, bindings: readBindings(bindings, node.type, [...path, 'bindings']) }
    : result) as unknown as NodeV8;
  return layoutKeys
    ? readLayoutFields(bound, value as Record<string, unknown>, autoLayout, layoutSizing, path)
    : bound;
}

/** V35-S2: the node types that hold `fills`. */
const FILL_TYPES: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'path',
  'custom',
  'frame',
  'symbol',
]);
/** V35-S2: the node types that take `passThrough`. */
const CONTAINER_BLEND_TYPES: ReadonlySet<string> = new Set([
  'group',
  'maskGroup',
  'frame',
  'symbol',
  'instance',
]);
const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colorDodge',
  'colorBurn',
  'hardLight',
  'softLight',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];
const CONTAINER_BLEND_MODES: readonly ContainerBlendMode[] = [...BLEND_MODES, 'passThrough'];

/** V35-S1: `passThrough` on containers and instances, `normal` on leaves. */
function defaultBlendMode(type: string): ContainerBlendMode {
  return CONTAINER_BLEND_TYPES.has(type) ? 'passThrough' : 'normal';
}

/** V35-S1: the one fill a v7 `fill` becomes. */
function defaultFill(paint: Paint): Fill {
  return { paint, visible: true, opacity: 1, blendMode: 'normal' };
}

function readBlendMode(value: unknown, type: string, path: Path): ContainerBlendMode {
  return readEnum(
    value,
    CONTAINER_BLEND_TYPES.has(type) ? CONTAINER_BLEND_MODES : BLEND_MODES,
    path,
  );
}

/** V35-S2, S3: at most MAX_FILLS entries, each `paint, visible, opacity, blendMode`. */
function readFills(value: unknown, path: Path): Fill[] {
  if (!Array.isArray(value) || value.length > MAX_FILLS) invalid(path);
  return readArray(value, path, (entry, entryPath): Fill => {
    const record = readRecord(entry, ['paint', 'visible', 'opacity', 'blendMode'], entryPath);
    return {
      paint: readPaint(record.paint, [...entryPath, 'paint']),
      visible: readBoolean(record.visible, [...entryPath, 'visible']),
      opacity: readNumber(record.opacity, [...entryPath, 'opacity'], 0, 1),
      blendMode: readEnum(record.blendMode, BLEND_MODES, [...entryPath, 'blendMode']),
    };
  });
}
const DIRECTIONS: readonly AutoLayout['direction'][] = ['horizontal', 'vertical'];
const PRIMARY_ALIGNS: readonly AutoLayout['primaryAlign'][] = [
  'start',
  'center',
  'end',
  'spaceBetween',
];
const COUNTER_ALIGNS: readonly AutoLayout['counterAlign'][] = ['start', 'center', 'end'];
const AXIS_SIZINGS: readonly AxisSizing[] = ['fixed', 'hug', 'fill'];
/** V34-S3: the bound of `gap` (either sign) and of each padding. */
export const MAX_LAYOUT_SPACING = 10000;

/**
 * V34-S1 to S3: `autoLayout` on a frame only, exact keys; `layoutSizing` exact keys, `hug` only
 * on a frame with `autoLayout`, fixed on both axes normalized away.
 */
function readLayoutFields(
  node: NodeV8,
  value: Record<string, unknown>,
  autoLayout: unknown,
  layoutSizing: unknown,
  path: Path,
): NodeV8 {
  let out: NodeV8 & LayoutFields = node;
  if (Object.hasOwn(value, 'autoLayout')) {
    const at = [...path, 'autoLayout'];
    if (node.type !== 'frame') invalid(at);
    const record = readRecord(
      autoLayout,
      ['direction', 'gap', 'padding', 'primaryAlign', 'counterAlign'],
      at,
    );
    const padding = record.padding;
    if (!Array.isArray(padding) || padding.length !== 4) invalid([...at, 'padding']);
    const pad = readArray(padding, [...at, 'padding'], (entry, entryPath) =>
      readNumber(entry, entryPath, 0, MAX_LAYOUT_SPACING),
    );
    out = {
      ...out,
      autoLayout: {
        direction: readEnum(record.direction, DIRECTIONS, [...at, 'direction']),
        gap: readNumber(record.gap, [...at, 'gap'], -MAX_LAYOUT_SPACING, MAX_LAYOUT_SPACING),
        padding: [pad[0]!, pad[1]!, pad[2]!, pad[3]!],
        primaryAlign: readEnum(record.primaryAlign, PRIMARY_ALIGNS, [...at, 'primaryAlign']),
        counterAlign: readEnum(record.counterAlign, COUNTER_ALIGNS, [...at, 'counterAlign']),
      },
    };
  }
  if (Object.hasOwn(value, 'layoutSizing')) {
    const at = [...path, 'layoutSizing'];
    const record = readRecord(layoutSizing, ['horizontal', 'vertical'], at);
    const sizing = {
      horizontal: readEnum(record.horizontal, AXIS_SIZINGS, [...at, 'horizontal']),
      vertical: readEnum(record.vertical, AXIS_SIZINGS, [...at, 'vertical']),
    };
    for (const axis of ['horizontal', 'vertical'] as const) {
      if (sizing[axis] === 'hug' && out.autoLayout === undefined) invalid([...at, axis]);
    }
    if (sizing.horizontal !== 'fixed' || sizing.vertical !== 'fixed') {
      out = { ...out, layoutSizing: sizing };
    }
  }
  return out;
}

/**
 * V35-S1 at v8: a node value with `fills` and `blendMode` taken out (`fill: null` standing in for
 * `fills`, so the v7 field reader runs unchanged), and which of the two it carried. A node with
 * both `fill` and `fills` fails at `fill`; `fills` or `blendMode` on a type without them fails
 * at that key, as an unknown key does.
 */
function readFillsShim(
  value: unknown,
  path: Path,
): { shim: unknown; fills: boolean; blend: boolean } | null {
  if (!isPlainObject(value)) return null;
  const fills = Object.hasOwn(value, 'fills');
  const blend = Object.hasOwn(value, 'blendMode');
  const shim: Record<string, unknown> = { ...value };
  delete shim.fills;
  delete shim.blendMode;
  if (fills) {
    if (Object.hasOwn(value, 'fill')) invalid([...path, 'fill']);
    if (!FILL_TYPES.has(value.type as string)) invalid([...path, 'fills']);
    shim.fill = null;
  }
  return { shim, fills, blend };
}

/**
 * V39-S6's node rule: a non-empty object whose keys are binding keys the node's type has a field
 * for, each exactly `{ style }` or `{ variable }` with a valid ID, returned in V39-S7 key order.
 */
function readBindings(value: unknown, type: string, path: Path): Bindings {
  if (!isPlainObject(value) || Object.keys(value).length === 0) invalid(path);
  for (const key of Object.keys(value)) {
    if (!(BINDING_KEYS as readonly string[]).includes(key)) invalid([...path, key]);
    if (!bindingKeyAllowed(type, key as BindingKey)) invalid([...path, key]);
  }
  const out: Partial<Record<BindingKey, BindingRef>> = {};
  for (const key of BINDING_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    const entryPath = [...path, key];
    if (hasExactKeys(entry, ['style'])) {
      out[key] = { style: readBindingId(entry.style, entryPath) };
    } else if (hasExactKeys(entry, ['variable'])) {
      out[key] = { variable: readBindingId(entry.variable, entryPath) };
    } else {
      invalid(entryPath);
    }
  }
  return out;
}

/** A binding's reference ID (V39-S6): a valid ID, else `invalid-field` at the binding. */
function readBindingId(value: unknown, path: Path): string {
  if (typeof value !== 'string' || !isValidId(value)) invalid(path);
  return value;
}

/** V39-S3: a table name, 1 to 200 UTF-16 units of valid run text. */
function readTableName(value: unknown, path: Path): string {
  const name = readString(value, path);
  if (name.length === 0 || name.length > MAX_TABLE_NAME_LENGTH || !isValidRunText(name)) {
    invalid(path);
  }
  return name;
}

/** V39-S1: 1 to 1,000 styles, each exactly `id, name, paint`. */
function readColorStyles(value: unknown, path: Path): ColorStyle[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COLOR_STYLES) {
    invalid(path);
  }
  return readArray(value, path, (entry, entryPath) => {
    const record = readRecord(entry, ['id', 'name', 'paint'], entryPath);
    return {
      id: readIdV2(record.id, [...entryPath, 'id']),
      name: readTableName(record.name, [...entryPath, 'name']),
      paint: readPaint(record.paint, [...entryPath, 'paint']),
    };
  });
}

const VARIABLE_TYPES: readonly Variable['type'][] = ['color', 'number'];

/**
 * V39-S2: exactly `modes, mode, items`; 1 to 16 modes (`id, name`), 1 to 1,000 variables (`id,
 * name, type, values`), each `values` exactly one key per mode, read in code-unit key order.
 * Whether `mode` names a mode is checked with the IDs (V39-S6 (3)).
 */
function readVariables(value: unknown, path: Path): VariableSet {
  const record = readRecord(value, ['modes', 'mode', 'items'], path);
  const modesPath = [...path, 'modes'];
  if (
    !Array.isArray(record.modes) ||
    record.modes.length === 0 ||
    record.modes.length > MAX_VARIABLE_MODES
  ) {
    invalid(modesPath);
  }
  const modes = readArray(record.modes, modesPath, (entry, entryPath) => {
    const mode = readRecord(entry, ['id', 'name'], entryPath);
    return {
      id: readIdV2(mode.id, [...entryPath, 'id']),
      name: readTableName(mode.name, [...entryPath, 'name']),
    };
  });
  const mode = readIdV2(record.mode, [...path, 'mode']);
  const itemsPath = [...path, 'items'];
  if (
    !Array.isArray(record.items) ||
    record.items.length === 0 ||
    record.items.length > MAX_VARIABLES
  ) {
    invalid(itemsPath);
  }
  const modeIds = modes.map((entry) => entry.id);
  const items = readArray(record.items, itemsPath, (entry, entryPath): Variable => {
    const item = readRecord(entry, ['id', 'name', 'type', 'values'], entryPath);
    const id = readIdV2(item.id, [...entryPath, 'id']);
    const name = readTableName(item.name, [...entryPath, 'name']);
    const type = readEnum(item.type, VARIABLE_TYPES, [...entryPath, 'type']);
    const valuesPath = [...entryPath, 'values'];
    if (!isPlainObject(item.values)) invalid(valuesPath);
    const values = item.values;
    const keys = Object.keys(values).sort(compareUnits);
    if (keys.length !== modeIds.length || modeIds.some((key) => !Object.hasOwn(values, key))) {
      invalid(valuesPath);
    }
    if (type === 'color') {
      const read = Object.fromEntries(
        keys.map((key) => [key, readColor(values[key], [...valuesPath, key])]),
      );
      return { id, name, type, values: read };
    }
    const read = Object.fromEntries(
      keys.map((key) => [key, readNumber(values[key], [...valuesPath, key])]),
    );
    return { id, name, type, values: read };
  });
  return { modes, mode, items };
}

function compareUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const EFFECT_KINDS_V7: readonly Effect['kind'][] = ['dropShadow', 'layerBlur'];
const EFFECT_KINDS_V8: readonly Effect['kind'][] = [
  ...EFFECT_KINDS_V7,
  'innerShadow',
  'backgroundBlur',
];

/**
 * E41-S2, S3 and V36-S1, S2 in key order: at most MAX_EFFECTS entries (at `effects`), each `kind`
 * first (one of `kinds`), then a shadow's `visible, color, offsetX, offsetY, radius` or a blur's
 * `visible, radius`; a second layer blur or background blur fails at its own index.
 */
function readEffects(value: unknown, path: Path, kinds: readonly Effect['kind'][]): Effect[] {
  if (!Array.isArray(value) || value.length > MAX_EFFECTS) invalid(path);
  const blurs = { layerBlur: 0, backgroundBlur: 0 };
  return readArray(value, path, (entry, entryPath): Effect => {
    if (!isPlainObject(entry)) invalid(entryPath);
    const kind = readEnum(entry.kind, kinds, [...entryPath, 'kind']);
    if (kind === 'layerBlur' || kind === 'backgroundBlur') {
      const record = readRecord(entry, ['kind', 'visible', 'radius'], entryPath);
      blurs[kind] += 1;
      if (blurs[kind] > 1) invalid(entryPath);
      return {
        kind,
        visible: readBoolean(record.visible, [...entryPath, 'visible']),
        radius: readNumber(record.radius, [...entryPath, 'radius'], 0, MAX_EFFECT_RADIUS),
      };
    }
    const record = readRecord(
      entry,
      ['kind', 'visible', 'color', 'offsetX', 'offsetY', 'radius'],
      entryPath,
    );
    return {
      kind,
      visible: readBoolean(record.visible, [...entryPath, 'visible']),
      color: readColor(record.color, [...entryPath, 'color']),
      offsetX: readNumber(
        record.offsetX,
        [...entryPath, 'offsetX'],
        -MAX_EFFECT_OFFSET,
        MAX_EFFECT_OFFSET,
      ),
      offsetY: readNumber(
        record.offsetY,
        [...entryPath, 'offsetY'],
        -MAX_EFFECT_OFFSET,
        MAX_EFFECT_OFFSET,
      ),
      radius: readNumber(record.radius, [...entryPath, 'radius'], 0, MAX_EFFECT_RADIUS),
    };
  });
}

/** One node's fields before `effects`; typed as v6 whatever the schema. */
function readNodeFields(key: string, value: unknown, path: Path, schema: Schema): NodeV6 {
  if (!isPlainObject(value)) invalid(path);
  const type = readEnum(value.type, schema.types, [...path, 'type']);
  const typeKeys =
    type === 'instance' && schema.overrides === 'read' ? INSTANCE_KEYS_V5 : NODE_KEYS_V2[type];
  const keys: string[] = [...typeKeys];
  // V38-S2: `layoutGrids` is optional, after `stroke` and before `effects`.
  if (
    schema.layout === 'read' &&
    (type === 'frame' || type === 'symbol') &&
    Object.hasOwn(value, 'layoutGrids')
  ) {
    keys.push('layoutGrids');
  }
  if (schema.effects === 'read') keys.push('effects');
  // V31-S1: the optional `locked` key at v8, after every other field.
  if (schema.effects === 'read' && schema.locked === 'read' && Object.hasOwn(value, 'locked')) {
    keys.push('locked');
  }
  const record = readRecord(value, keys, path);
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
  // Container opacity other than 1 (M1-S5, and M7-S4 for an instance) is lifted at v6 (M4
  // contract, M4-L1 and M4-S5); an input below v6 still fails, since no build wrote one (M4-M2).
  if (
    schema.containerOpacity === 'one' &&
    (isContainerType(type) || type === 'instance') &&
    base.opacity !== 1
  ) {
    invalid([...path, 'opacity']);
  }
  const readers = strokeReaders(schema);
  const fill = () => readNullable(record.fill, [...path, 'fill'], readers.fill);
  const shapeStroke = () =>
    readNullable(record.stroke, [...path, 'stroke'], readers.shape) as Stroke | null;
  const pathStroke = () =>
    readNullable(record.stroke, [...path, 'stroke'], readers.path) as Stroke | null;
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
        stroke: shapeStroke(),
      };
    case 'ellipse':
      return {
        ...base,
        type,
        fill: fill(),
        stroke: shapeStroke(),
      };
    case 'line':
      return {
        ...base,
        type,
        points: readTuple4(record.points, [...path, 'points'], 0, 1),
        stroke: pathStroke(),
        startArrow: readEnum(record.startArrow, ARROWS, [...path, 'startArrow']),
        endArrow: readEnum(record.endArrow, ARROWS, [...path, 'endArrow']),
      };
    case 'path':
      return {
        ...base,
        type,
        path: readPathData(record.path, [...path, 'path']),
        fill: fill(),
        stroke: pathStroke(),
      };
    case 'custom':
      return {
        ...base,
        type,
        customType: readId(record.customType, [...path, 'customType']),
        data: readJson(record.data, [...path, 'data']),
        fill: fill(),
        stroke: pathStroke(),
      };
    case 'group':
    case 'maskGroup':
      return { ...base, type, children: children() };
    case 'frame':
    case 'symbol': {
      const container = {
        ...base,
        type,
        children: children(),
        fill: fill(),
        stroke: shapeStroke(),
      };
      if (!keys.includes('layoutGrids')) return container;
      const layoutGrids = readLayoutGrids(record.layoutGrids, [...path, 'layoutGrids']);
      return layoutGrids.length === 0 ? container : ({ ...container, layoutGrids } as NodeV6);
    }
    case 'instance': {
      const symbol = readIdV2(record.symbol, [...path, 'symbol']);
      // Before v5 the node has no overrides; the result is typed by the caller's version.
      if (schema.overrides === 'none') return { ...base, type, symbol } as unknown as NodeV6;
      const textOverrides =
        schema.overrides === 'read'
          ? readOverrides(record.textOverrides, [...path, 'textOverrides'])
          : {};
      return { ...base, type, symbol, textOverrides };
    }
    case 'text':
      return {
        ...base,
        type,
        runs: readRuns(record.runs, [...path, 'runs']),
        sizing: readEnum(record.sizing, SIZINGS, [...path, 'sizing']),
        align: readEnum(record.align, ALIGNS, [...path, 'align']),
        letterSpacing: readNumber(record.letterSpacing, [...path, 'letterSpacing'], -1, 10),
        lineHeight: readNumber(record.lineHeight, [...path, 'lineHeight'], 0.1, 10),
      };
  }
}

function readPage(value: unknown, path: Path, schema: Schema): PageV8 {
  const keys = ['id', 'name', 'children'];
  if (schema.layout === 'read' && isPlainObject(value) && Object.hasOwn(value, 'guides')) {
    keys.push('guides');
  }
  const record = readRecord(value, keys, path);
  const page = {
    id: readIdV2(record.id, [...path, 'id']),
    name: readString(record.name, [...path, 'name']),
    children: readArray(record.children, [...path, 'children'], (entry, entryPath) =>
      readIdV2(entry, entryPath),
    ),
  };
  if (!keys.includes('guides')) return page;
  const guides = readGuides(record.guides, [...path, 'guides']);
  return guides.length === 0 ? page : { ...page, guides };
}

const GUIDE_AXES: readonly Guide['axis'][] = ['x', 'y'];
const BAND_ALIGNS: readonly BandLayoutGrid['align'][] = ['stretch', 'start', 'center', 'end'];

/** V38-S1: at most MAX_GUIDES guides, each `axis, value`. */
function readGuides(value: unknown, path: Path): Guide[] {
  if (!Array.isArray(value) || value.length > MAX_GUIDES) invalid(path);
  return readArray(value, path, (entry, entryPath) => {
    const record = readRecord(entry, ['axis', 'value'], entryPath);
    return {
      axis: readEnum(record.axis, GUIDE_AXES, [...entryPath, 'axis']),
      value: readNumber(record.value, [...entryPath, 'value'], -MAX_GUIDE_VALUE, MAX_GUIDE_VALUE),
    };
  });
}

/** V38-S2: at most MAX_LAYOUT_GRIDS grids in their key order. */
function readLayoutGrids(value: unknown, path: Path): LayoutGrid[] {
  if (!Array.isArray(value) || value.length > MAX_LAYOUT_GRIDS) invalid(path);
  return readArray(value, path, (entry, entryPath): LayoutGrid => {
    if (!isPlainObject(entry)) invalid(entryPath);
    const type = readEnum(entry.type, LAYOUT_GRID_TYPES, [...entryPath, 'type']);
    if (type === 'grid') {
      const record = readRecord(entry, ['type', 'size', 'color', 'visible'], entryPath);
      const size = readNumber(record.size, [...entryPath, 'size'], 0, MAX_GRID_SIZE);
      if (size === 0) invalid([...entryPath, 'size']);
      return {
        type,
        size,
        color: readColor(record.color, [...entryPath, 'color']),
        visible: readBoolean(record.visible, [...entryPath, 'visible']),
      };
    }
    const record = readRecord(
      entry,
      ['type', 'count', 'align', 'size', 'gutter', 'offset', 'color', 'visible'],
      entryPath,
    );
    const count = readNumber(record.count, [...entryPath, 'count'], 1, MAX_GRID_COUNT);
    if (!Number.isInteger(count)) invalid([...entryPath, 'count']);
    const align = readEnum(record.align, BAND_ALIGNS, [...entryPath, 'align']);
    const size = readNumber(record.size, [...entryPath, 'size'], 0, MAX_GRID_VALUE);
    if (size === 0) invalid([...entryPath, 'size']);
    return {
      type,
      count,
      align,
      size,
      gutter: readNumber(record.gutter, [...entryPath, 'gutter'], 0, MAX_GRID_VALUE),
      offset: readNumber(record.offset, [...entryPath, 'offset'], 0, MAX_GRID_VALUE),
      color: readColor(record.color, [...entryPath, 'color']),
      visible: readBoolean(record.visible, [...entryPath, 'visible']),
    };
  });
}

const LAYOUT_GRID_TYPES: readonly LayoutGrid['type'][] = ['grid', 'columns', 'rows'];

/** The result of `validateGuides`. */
export type GuidesResult =
  | Readonly<{ ok: true; guides: readonly Guide[] }>
  | Readonly<{ ok: false; code: 'document.invalid-field'; path: string }>;

/**
 * Validates a page's guides with the rules of `validateDocument` (V38-S1), for the `setGuides`
 * command; `path` is relative to the array.
 */
export function validateGuides(value: unknown): GuidesResult {
  try {
    return { ok: true, guides: readGuides(value, []) };
  } catch (error) {
    if (error instanceof Failure) {
      return { ok: false, code: 'document.invalid-field', path: pointer(error.path) };
    }
    throw error;
  }
}

/** A document's `id`, `pages` and `nodes`, typed as those of `D` (v8 unless migrating). */
type Tree<D extends { pages: unknown; nodes: unknown } = DocumentV8> = Readonly<{
  id: string;
  /** V-39: present only when read at v8 and given. */
  colorStyles?: readonly ColorStyle[];
  variables?: VariableSet;
  pages: D['pages'];
  nodes: D['nodes'];
}>;

/** A v8 document read with the schema of its source version (an older one when migrating). */
function readDocumentV8(value: Record<string, unknown>, schema: Schema): DocumentV8 {
  const { id, colorStyles, variables, pages, nodes } = readTree(value, schema, true);
  return {
    schemaVersion: 8,
    id,
    ...(colorStyles === undefined ? {} : { colorStyles }),
    ...(variables === undefined ? {} : { variables }),
    pages,
    nodes,
  };
}

/**
 * The document rules in the M7 contract's section 2 order: fields, ownership, M7-S2, the cycle
 * walk with the base tree depth, M7-S3, the M7-T3 override keys, the M7-S5 tree depth, then the
 * group and mask rules.
 * `references` false skips only M7-S2, the override keys and M7-S5, for `validateFragmentTree`.
 */
function readTree(value: Record<string, unknown>, schema: Schema, references: boolean): Tree {
  // V39-S1, S2: a v8 document (not a fragment) may add `colorStyles` and `variables`.
  const optional =
    schema.tables === 'read' && references && isPlainObject(value)
      ? (['colorStyles', 'variables'] as const).filter((key) => Object.hasOwn(value, key))
      : [];
  const record = readRecord(value, ['schemaVersion', 'id', ...optional, 'pages', 'nodes'], []);
  const id = readIdV2(record.id, ['id']);
  if (!Array.isArray(record.pages) || record.pages.length === 0) invalid(['pages']);
  const pages = readArray(record.pages, ['pages'], (entry, entryPath) =>
    readPage(entry, entryPath, schema),
  );
  if (!isPlainObject(record.nodes)) invalid(['nodes']);
  const entries = Object.entries(record.nodes).map(
    ([key, node]) => [key, readNode(key, node, ['nodes', key], schema)] as const,
  );
  const nodes: Record<string, NodeV8> = Object.fromEntries(entries);

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

  // M7-S3: no instance and no symbol inside a symbol. A text node may be (M7-T1).
  for (const [key, node] of entries) {
    const nested = node.type === 'instance' || node.type === 'symbol';
    if (nested && symbolAbove.has(key)) {
      throw new Failure('document.invalid-symbol', ['nodes', key, 'parent']);
    }
  }

  // M7-T3: each override key names a text node of the instance's source subtree.
  if (references) {
    for (const [key, node] of entries) {
      if (node.type !== 'instance' || !('textOverrides' in node)) continue;
      for (const name of Object.keys(node.textOverrides)) {
        const target = Object.hasOwn(nodes, name) ? nodes[name]! : undefined;
        if (target?.type !== 'text' || symbolAbove.get(name) !== node.symbol) {
          throw new Failure('document.invalid-symbol', ['nodes', key, 'textOverrides', name]);
        }
      }
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
  if (schema.tables !== 'read' || !references) return { id, pages, nodes };
  const { colorStyles, variables } = readTables(record, id, pages, nodes);
  return {
    id,
    ...(colorStyles === undefined ? {} : { colorStyles }),
    ...(variables === undefined ? {} : { variables }),
    pages,
    nodes,
  };
}

/**
 * V39-S6's document checks after every node and tree rule: (1) the tables' shapes; (2) ID
 * uniqueness across the document, pages, nodes and tables; (3) the active mode; (4) each node's
 * bindings in code-unit ID order and S4 key order: a missing target, then the kind, type, null
 * field, value and range (V39-S5).
 */
function readTables(
  record: Record<string, unknown>,
  id: string,
  pages: readonly PageV8[],
  nodes: Readonly<Record<string, NodeV8>>,
): BindingTables {
  const colorStyles = Object.hasOwn(record, 'colorStyles')
    ? readColorStyles(record.colorStyles, ['colorStyles'])
    : undefined;
  const variables = Object.hasOwn(record, 'variables')
    ? readVariables(record.variables, ['variables'])
    : undefined;
  // The document ID is not in the set: an older document may share it with a node.
  void id;
  const taken = new Set<string>([...pages.map((page) => page.id), ...Object.keys(nodes)]);
  const claim = (key: string, path: Path) => {
    if (taken.has(key)) throw new Failure('document.duplicate-id', path);
    taken.add(key);
  };
  colorStyles?.forEach((style, index) => claim(style.id, ['colorStyles', index, 'id']));
  variables?.items.forEach((item, index) => claim(item.id, ['variables', 'items', index, 'id']));
  variables?.modes.forEach((mode, index) => claim(mode.id, ['variables', 'modes', index, 'id']));
  if (variables !== undefined && !variables.modes.some((mode) => mode.id === variables.mode)) {
    throw new Failure('document.dangling-reference', ['variables', 'mode']);
  }
  const tables: BindingTables = {
    ...(colorStyles === undefined ? {} : { colorStyles }),
    ...(variables === undefined ? {} : { variables }),
  };
  for (const key of Object.keys(nodes).sort(compareUnits)) {
    const node = nodes[key]!;
    if (node.bindings === undefined) continue;
    for (const name of BINDING_KEYS) {
      const ref = node.bindings[name];
      if (ref === undefined) continue;
      const path = ['nodes', key, 'bindings', name];
      if (bindingTarget(tables, ref) === null) {
        throw new Failure('document.dangling-reference', path);
      }
      if (!bindingHolds(node, name, ref, tables)) invalid(path);
    }
  }
  return tables;
}
