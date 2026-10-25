import type { DocumentV1, JsonValue, NodeV1, PathData } from '@vector-studio/model';
import type { CustomNodeType, Extension, ExtensionApi, ExtensionCommand, Query } from './types.js';

// The extension registry (P5 plan, section 5): custom node types and extension commands,
// registered once at construction. Extensions reach the editor only through `ExtensionApi`.

/** A custom-node check failure; `path` is relative to the node. */
export type CustomFailure = Readonly<{
  code: 'document.unknown-custom-type' | 'document.invalid-custom-data';
  path: string;
}>;

const VERBS = new Set(['move', 'line', 'cubic', 'close']);
const POINTS_PER_VERB: Readonly<Record<string, number>> = { move: 2, line: 2, cubic: 6, close: 0 };

function owned(extension: string, id: unknown): boolean {
  return typeof id === 'string' && (id === extension || id.startsWith(`${extension}.`));
}

/** Plain path data from an extension's `toScene` output, or null when it is not well formed. */
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
  if (points.length !== expected) return null;
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

  /** Throws on a malformed or conflicting registration: that is a host programming error. */
  constructor(extensions: readonly Extension[]) {
    const ids = new Set<string>();
    for (const extension of extensions) {
      const { id } = extension;
      if (typeof id !== 'string' || id.length === 0 || ids.has(id)) {
        throw new Error(`createEditor: invalid or duplicate extension id ${String(id)}`);
      }
      ids.add(id);
      for (const type of extension.nodeTypes ?? []) {
        if (!owned(id, type.customType) || this.types.has(type.customType)) {
          throw new Error(`createEditor: ${id} cannot register custom type ${type.customType}`);
        }
        this.types.set(type.customType, type);
      }
      for (const command of extension.commands ?? []) {
        if (!owned(id, command.id) || this.commands.has(command.id)) {
          throw new Error(`createEditor: ${id} cannot register command ${command.id}`);
        }
        this.commands.set(command.id, command);
      }
    }
  }

  /** The default data of a registered custom type, or undefined for an unknown one. */
  defaults(customType: string): JsonValue | undefined {
    return this.types.get(customType)?.defaults();
  }

  /** Checks a custom node against its extension; other nodes always pass. */
  check(node: NodeV1): CustomFailure | null {
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

  /** The first custom node of the document that fails its check, with a document path. */
  checkDocument(document: DocumentV1): CustomFailure | null {
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
  geometry(node: NodeV1): PathData | null {
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

/** The only editor surface an extension sees: a fresh object with two functions. */
export function extensionApi(api: ExtensionApi): ExtensionApi {
  return Object.freeze({
    execute: (command) => api.execute(command),
    query: <Q extends Query>(query: Q) => api.query(query),
  });
}
