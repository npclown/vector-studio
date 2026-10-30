import type { DocumentV6, JsonValue, NodeV6, PathData } from '@vector-studio/model';
import { TOOL_NAMES } from './keymap.js';
import type {
  CustomNodeType,
  Extension,
  ExtensionApi,
  ExtensionCommand,
  ExtensionTool,
  PagePoint,
  PathAnchor,
  Query,
  ToolOverlay,
} from './types.js';

// The extension registry (P5 plan, section 5): custom node types, extension commands and
// extension tools (MVP M2 contract, section 7), registered once at construction. Extensions
// reach the editor only through `ExtensionApi` and, for tools, `ToolApi`.

/** A registered extension tool: frozen, its methods bound to the host's object. */
export type RegisteredTool = Readonly<{
  id: string;
  /** The ID of the extension that registered it. */
  owner: string;
  input: ExtensionTool['input'];
  reset: ExtensionTool['reset'];
  overlay: (() => unknown) | null;
}>;

/** A custom-node check failure; `path` is relative to the node. */
export type CustomFailure = Readonly<{
  code: 'document.unknown-custom-type' | 'document.invalid-custom-data';
  path: string;
}>;

const VERBS = new Set(['move', 'line', 'cubic', 'close']);
const POINTS_PER_VERB: Readonly<Record<string, number>> = { move: 2, line: 2, cubic: 6, close: 0 };

/** Data for a new custom node, or why there is none. */
export type CustomDefaults = Readonly<{ data: JsonValue }> | CustomFailure;

/** The P2 v1 path grammar of the renderer: `move` opens a subpath, `line` and `cubic` need one. */
function hasPathGrammar(verbs: readonly string[]): boolean {
  let open = false;
  for (const verb of verbs) {
    if (verb === 'move') open = true;
    else if (verb === 'close') {
      if (!open) return false;
      open = false;
    } else if (!open) return false;
  }
  return true;
}

export function owned(extension: string, id: unknown): boolean {
  return typeof id === 'string' && (id === extension || id.startsWith(`${extension}.`));
}

/**
 * Plain path data from an extension's `toScene` output, or null when it is empty or not well
 * formed by the renderer's rules, so a node is either drawn and hittable or neither.
 */
function pathData(value: unknown): PathData | null {
  if (typeof value !== 'object' || value === null) return null;
  const { verbs, points, fillRule } = value as Record<string, unknown>;
  if (!Array.isArray(verbs) || !Array.isArray(points)) return null;
  if (fillRule !== 'nonzero' && fillRule !== 'evenodd') return null;
  let expected = 0;
  for (const verb of verbs as unknown[]) {
    if (typeof verb !== 'string' || !VERBS.has(verb)) return null;
    expected += POINTS_PER_VERB[verb]!;
  }
  if (points.length !== expected || verbs.length === 0) return null;
  if (!hasPathGrammar(verbs as string[])) return null;
  const copy: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point: unknown = points[i];
    if (typeof point !== 'number' || !Number.isFinite(point)) return null;
    copy.push(point + 0);
  }
  return Object.freeze({
    verbs: Object.freeze([...(verbs as PathData['verbs'])]),
    points: Object.freeze(copy),
    fillRule,
  });
}

export class ExtensionRegistry {
  private readonly types = new Map<string, CustomNodeType>();
  private readonly commands = new Map<string, ExtensionCommand>();
  /** In registration order. */
  private readonly toolMap = new Map<string, RegisteredTool>();

  /**
   * Throws on a malformed or conflicting registration: that is a host programming error. The
   * registry keeps its own frozen copies, so later changes to the host's objects have no effect.
   */
  constructor(extensions: readonly Extension[]) {
    const ids: string[] = [];
    const reject = (what: string): never => {
      throw new Error(`createEditor: ${what}`);
    };
    for (const extension of extensions as readonly unknown[]) {
      if (typeof extension !== 'object' || extension === null)
        reject('an extension is not an object');
      const { id, nodeTypes = [], commands = [], tools = [] } = extension as Extension;
      if (typeof id !== 'string' || id.length === 0) reject(`invalid extension id ${String(id)}`);
      // One extension may not own another's namespace, so every ID has exactly one owner.
      if (ids.some((other) => owned(other, id) || owned(id, other))) {
        reject(`extension id ${id} overlaps another extension`);
      }
      ids.push(id);
      if (!Array.isArray(nodeTypes) || !Array.isArray(commands) || !Array.isArray(tools)) {
        reject(`${id} has malformed nodeTypes, commands or tools`);
      }
      for (const type of nodeTypes as readonly unknown[]) {
        const entry = type as Partial<CustomNodeType> | null;
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !owned(id, entry.customType) ||
          this.types.has(entry.customType!) ||
          typeof entry.validate !== 'function' ||
          typeof entry.defaults !== 'function' ||
          typeof entry.toScene !== 'function'
        ) {
          reject(`${id} cannot register custom type ${String(entry?.customType)}`);
        }
        // Methods stay bound to the host's object, so a class-based type keeps its `this`.
        const own = entry as CustomNodeType;
        this.types.set(
          own.customType,
          Object.freeze({
            customType: own.customType,
            validate: own.validate.bind(own),
            defaults: own.defaults.bind(own),
            toScene: own.toScene.bind(own),
          }),
        );
      }
      for (const command of commands as readonly unknown[]) {
        const entry = command as Partial<ExtensionCommand> | null;
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !owned(id, entry.id) ||
          this.commands.has(entry.id!) ||
          typeof entry.run !== 'function'
        ) {
          reject(`${id} cannot register command ${String(entry?.id)}`);
        }
        const own = entry as ExtensionCommand;
        this.commands.set(own.id, Object.freeze({ id: own.id, run: own.run.bind(own) }));
      }
      // Tool IDs follow the command rule (owned, unique) and never shadow a built-in tool.
      for (const tool of tools as readonly unknown[]) {
        const entry = tool as Partial<ExtensionTool> | null;
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !owned(id, entry.id) ||
          (TOOL_NAMES as readonly string[]).includes(entry.id!) ||
          this.toolMap.has(entry.id!) ||
          typeof entry.input !== 'function' ||
          typeof entry.reset !== 'function' ||
          (entry.overlay !== undefined && typeof entry.overlay !== 'function')
        ) {
          reject(`${id} cannot register tool ${String(entry?.id)}`);
        }
        const own = entry as ExtensionTool;
        this.toolMap.set(
          own.id,
          Object.freeze({
            id: own.id,
            owner: id,
            input: own.input.bind(own),
            reset: own.reset.bind(own),
            overlay: own.overlay === undefined ? null : own.overlay.bind(own),
          }),
        );
      }
    }
  }

  /** The registered extension tools in registration order. */
  get tools(): readonly RegisteredTool[] {
    return [...this.toolMap.values()];
  }

  tool(id: string): RegisteredTool | undefined {
    return this.toolMap.get(id);
  }

  /** The default data of a custom type; a throw or an `undefined` result is invalid data. */
  defaults(customType: string): CustomDefaults {
    const type = this.types.get(customType);
    if (type === undefined) return { code: 'document.unknown-custom-type', path: '/customType' };
    let data: JsonValue | undefined;
    try {
      data = type.defaults();
    } catch {
      data = undefined;
    }
    return data === undefined ? { code: 'document.invalid-custom-data', path: '/data' } : { data };
  }

  /** Checks a custom node against its extension; other nodes always pass. */
  check(node: NodeV6): CustomFailure | null {
    if (node.type !== 'custom') return null;
    const type = this.types.get(node.customType);
    if (type === undefined) return { code: 'document.unknown-custom-type', path: '/customType' };
    let valid: boolean;
    try {
      valid = type.validate(node.data) === true;
    } catch {
      valid = false;
    }
    return valid ? null : { code: 'document.invalid-custom-data', path: '/data' };
  }

  /**
   * The first custom node of the document that fails its check, with a document path. Every node
   * is checked wherever it is nested (M1 contract, section 2.1), in sorted ID order.
   */
  checkDocument(document: DocumentV6): CustomFailure | null {
    for (const id of Object.keys(document.nodes).sort()) {
      const failure = this.check(document.nodes[id]!);
      if (failure !== null) {
        const key = id.replaceAll('~', '~0').replaceAll('/', '~1');
        return { code: failure.code, path: `/nodes/${key}${failure.path}` };
      }
    }
    return null;
  }

  /** Frame-local geometry of a custom node through its extension's `toScene`, or null. */
  geometry(node: NodeV6): PathData | null {
    if (node.type !== 'custom') return null;
    const type = this.types.get(node.customType);
    if (type === undefined) return null;
    try {
      return pathData(type.toScene(node.data, node.frame));
    } catch {
      return null;
    }
  }

  command(id: string): ExtensionCommand | undefined {
    return this.commands.get(id);
  }
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointCopy(value: unknown): PagePoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  return finite(x) && finite(y) ? { x: x + 0, y: y + 0 } : null;
}

/**
 * A frozen plain copy of an extension tool's overlay, or null when the value is not a
 * `ToolOverlay` with finite numbers, so the host never draws the extension's own objects.
 */
export function toolOverlay(value: unknown): ToolOverlay | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'marquee') {
    const frame = record.frame as Record<string, unknown> | null;
    if (typeof frame !== 'object' || frame === null) return null;
    const { x, y, width, height } = frame;
    if (!(finite(x) && finite(y) && finite(width) && finite(height))) return null;
    return Object.freeze({
      kind: 'marquee',
      frame: Object.freeze({ x: x + 0, y: y + 0, width: width + 0, height: height + 0 }),
    });
  }
  if (record.kind === 'path') {
    if (!Array.isArray(record.anchors)) return null;
    const anchors: PathAnchor[] = [];
    for (const anchor of record.anchors as unknown[]) {
      if (typeof anchor !== 'object' || anchor === null) return null;
      const entry = anchor as Record<string, unknown>;
      const point = pointCopy(entry.point);
      const handleIn = entry.in === null ? null : pointCopy(entry.in);
      const handleOut = entry.out === null ? null : pointCopy(entry.out);
      if (point === null || (entry.in !== null && handleIn === null)) return null;
      if (entry.out !== null && handleOut === null) return null;
      anchors.push(
        Object.freeze({
          point: Object.freeze(point),
          in: handleIn === null ? null : Object.freeze(handleIn),
          out: handleOut === null ? null : Object.freeze(handleOut),
        }),
      );
    }
    return Object.freeze({ kind: 'path', anchors: Object.freeze(anchors) });
  }
  return null;
}

/** The only editor surface an extension sees: a fresh object with two functions. */
export function extensionApi(api: ExtensionApi): ExtensionApi {
  return Object.freeze({
    execute: (command) => api.execute(command),
    query: <Q extends Query>(query: Q) => api.query(query),
  });
}
