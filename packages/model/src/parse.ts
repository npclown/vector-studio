import { MAX_DEPTH, scanJson } from './json-scan.js';
import type {
  Arrow,
  Color,
  Constraint,
  Constraints,
  DocumentV1,
  DocumentV2,
  DocumentV3,
  DocumentV4,
  DocumentV5,
  DocumentV6,
  NodeV6,
  PageV6,
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

/** The latest schema version, which every validated document has (M4 contract, section 2). */
export type ParseResult = Readonly<{ ok: true; document: DocumentV6 }> | ModelFailure;

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
  Readonly<{ ok: true; nodes: Readonly<Record<string, NodeV6>> }> | ModelFailure;

export type NodeResult =
  | Readonly<{ ok: true; node: NodeV6 }>
  | Readonly<{ ok: false; code: 'document.invalid-field'; path: string }>;

/** Deepest container nesting of the node tree (ancestors that are containers). */
export const MAX_TREE_DEPTH = 256;

/** The most UTF-16 units of one text node's runs together (M6a-S4). */
export const MAX_TEXT_LENGTH = 16_384;

/** The most stops of one gradient (M4-S2); mirrors the contracts `SCENE_MAX_GRADIENT_STOPS`. */
export const MAX_GRADIENT_STOPS = 16;

/** The most entries of one dash pattern (M4-S4); mirrors the contracts `SCENE_MAX_DASH_ENTRIES`. */
export const MAX_DASH_ENTRIES = 16;

/**
 * IDs are opaque non-empty strings, unique across the document's pages and nodes, without
 * U+0000, which synthetic scene IDs use (M1-S4).
 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000');
}

/**
 * Parses JSON text of schema version 1 to 6 into a validated v6 document (M1 contract, section
 * 2.1; M7 contract, section 2.1; M6a contract, sections 2.1 and 9; M4 contract, section 2.1);
 * older versions are migrated by `migrateV1toV2` to `migrateV5toV6`. No partial document is ever
 * returned.
 */
export function parseDocument(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'document.malformed-json', path: '' };
  }
  const version = checkVersion(value, [1, 2, 3, 4, 5, 6]);
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
 * Validates an in-memory v6 document value and returns a normalized copy: negative zero becomes
 * 0, rotations are normalized, text override keys are in code unit order and nothing is shared
 * with the input. A v1 to v5 value is `document.unsupported-version`; `validateAnyDocument`
 * accepts every version.
 */
export function validateDocument(value: unknown): ParseResult {
  const version = checkVersion(value, [6]);
  if (version !== null) return version;
  return guarded(() => readDocumentV6(value as Record<string, unknown>, V6));
}

/**
 * Validates an in-memory v1 to v6 value and returns a normalized v6 copy (older versions are
 * migrated).
 */
export function validateAnyDocument(value: unknown): ParseResult {
  const version = checkVersion(value, [1, 2, 3, 4, 5, 6]);
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
    return v5.ok ? migrateV5toV6(v5.document) : v5;
  }
  // A v2 to v5 value is read once with its version's node types; the v6 result differs only in
  // its version, the empty `textOverrides` of every instance below v5 (`migrateV4toV5`) and the
  // v6 strokes (`migrateV5toV6`).
  const schema =
    record.schemaVersion === 2
      ? V2_TO_V6
      : record.schemaVersion === 3
        ? V3_TO_V6
        : record.schemaVersion === 4
          ? V4_TO_V6
          : record.schemaVersion === 5
            ? V5_TO_V6
            : V6;
  return guarded(() => readDocumentV6(record, schema));
}

/**
 * The model's tree rules for a clipboard fragment (M7 contract, section 6), on a holder document
 * value of the latest schema version, 6 (M4 contract, section 7), whose pages hold the fragment
 * roots: `{ schemaVersion: 6, id, pages: [{ id, name, children: roots }], nodes }`, exactly the
 * four keys of a document, with `id` and the page ID not keys of `nodes` and each root's `parent`
 * the page ID (the caller rewrites the fragment's `""`). It runs every rule of `validateDocument`
 * except two, which the fragment rules and the paste resolve instead: M7-S2 (each instance names
 * a `symbol` of the same document, and with it the M7-T3 rule that each text override key names a
 * text node of the instance's source) and M7-S5 (the tree depth through an expansion). M7-S3
 * nesting and the base tree depth still run. Returns the normalized node map, never a document;
 * no document entry point skips these rules.
 */
export function validateFragmentTree(value: unknown): FragmentTreeResult {
  const version = checkVersion(value, [6]);
  if (version !== null) return version;
  try {
    const tree = readTree(value as Record<string, unknown>, V6, false);
    return { ok: true, nodes: tree.nodes };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, code: error.code, path: pointer(error.path) };
    throw error;
  }
}

/** Options of `validateNode`. */
export type ValidateNodeOptions = Readonly<{
  /**
   * The node comes from an input below v6 (an older clipboard fragment), already given the v6
   * fields: a container or instance opacity other than 1 fails at `/opacity`, in the field order
   * of an older document (M4 contract, M4-M2 and section 7).
   */
  olderInput?: boolean;
}>;

/**
 * Validates one v6 node with the field rules of `validateDocument`, so commands reject the values
 * a load would reject. `path` is relative to the node; references (M7-S2 and the M7-T3 override
 * keys among them) are not checked here.
 */
export function validateNode(value: unknown, options: ValidateNodeOptions = {}): NodeResult {
  const schema = options.olderInput === true ? V6_OLDER_OPACITY : V6;
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
export function migrateV5toV6(document: DocumentV5): ParseResult {
  return guarded(() => readDocumentV6({ ...document, schemaVersion: 6 }, V5_TO_V6));
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
}>;

const V4_TYPES = Object.keys(NODE_KEYS_V2) as NodeTypeKey[];
const V3_TYPES = V4_TYPES.filter((type) => type !== 'text');
const V2_TYPES = V3_TYPES.filter((type) => type !== 'symbol' && type !== 'instance');
const OLDER = { containerOpacity: 'one' } as const;
const V2: Schema = { types: V2_TYPES, overrides: 'none', appearance: 'none', ...OLDER };
const V3: Schema = { types: V3_TYPES, overrides: 'none', appearance: 'none', ...OLDER };
const V4_TO_V5: Schema = { types: V4_TYPES, overrides: 'added', appearance: 'none', ...OLDER };
const V2_TO_V6: Schema = { types: V2_TYPES, overrides: 'added', appearance: 'added', ...OLDER };
const V3_TO_V6: Schema = { types: V3_TYPES, overrides: 'added', appearance: 'added', ...OLDER };
const V4_TO_V6: Schema = { types: V4_TYPES, overrides: 'added', appearance: 'added', ...OLDER };
const V5_TO_V6: Schema = { types: V4_TYPES, overrides: 'read', appearance: 'added', ...OLDER };
const V6: Schema = {
  types: V4_TYPES,
  overrides: 'read',
  appearance: 'read',
  containerOpacity: 'any',
};
/** v6 nodes of an input below v6, already migrated: v6 fields, the older opacity rule. */
const V6_OLDER_OPACITY: Schema = { ...V6, ...OLDER };

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
function readNode(key: string, value: unknown, path: Path, schema: Schema): NodeV6 {
  if (!isPlainObject(value)) invalid(path);
  const type = readEnum(value.type, schema.types, [...path, 'type']);
  const keys =
    type === 'instance' && schema.overrides === 'read' ? INSTANCE_KEYS_V5 : NODE_KEYS_V2[type];
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
    case 'symbol':
      return {
        ...base,
        type,
        children: children(),
        fill: fill(),
        stroke: shapeStroke(),
      };
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

function readPage(value: unknown, path: Path): PageV6 {
  const record = readRecord(value, ['id', 'name', 'children'], path);
  return {
    id: readIdV2(record.id, [...path, 'id']),
    name: readString(record.name, [...path, 'name']),
    children: readArray(record.children, [...path, 'children'], (entry, entryPath) =>
      readIdV2(entry, entryPath),
    ),
  };
}

/** A document's `id`, `pages` and `nodes`, typed as those of `D` (v6 unless migrating). */
type Tree<D extends { pages: unknown; nodes: unknown } = DocumentV6> = Readonly<{
  id: string;
  pages: D['pages'];
  nodes: D['nodes'];
}>;

/** A v6 document read with the schema of its source version (an older one when migrating). */
function readDocumentV6(value: Record<string, unknown>, schema: Schema): DocumentV6 {
  return { schemaVersion: 6, ...readTree(value, schema, true) };
}

/**
 * The document rules in the M7 contract's section 2 order: fields, ownership, M7-S2, the cycle
 * walk with the base tree depth, M7-S3, the M7-T3 override keys, the M7-S5 tree depth, then the
 * group and mask rules.
 * `references` false skips only M7-S2, the override keys and M7-S5, for `validateFragmentTree`.
 */
function readTree(value: Record<string, unknown>, schema: Schema, references: boolean): Tree {
  const record = readRecord(value, ['schemaVersion', 'id', 'pages', 'nodes'], []);
  const id = readIdV2(record.id, ['id']);
  if (!Array.isArray(record.pages) || record.pages.length === 0) invalid(['pages']);
  const pages = readArray(record.pages, ['pages'], readPage);
  if (!isPlainObject(record.nodes)) invalid(['nodes']);
  const entries = Object.entries(record.nodes).map(
    ([key, node]) => [key, readNode(key, node, ['nodes', key], schema)] as const,
  );
  const nodes: Record<string, NodeV6> = Object.fromEntries(entries);

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
  return { id, pages, nodes };
}
