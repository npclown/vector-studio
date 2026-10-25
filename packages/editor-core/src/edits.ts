import { validateNode, type DocumentV1, type NodeV1 } from '@vector-studio/model';
import type { CommandResult, DocumentCommand, EditorErrorCode, IdSource } from './types.js';

// Pure document edits: each takes a valid document and returns a new valid document, or a
// failure that leaves nothing changed. Nodes are validated with the model's own field rules.

export type EditResult =
  | Readonly<{
      ok: true;
      document: DocumentV1;
      /** Nodes created, changed or removed. */
      touched: readonly string[];
      /** Nodes the command created. */
      created: readonly string[];
    }>
  | Extract<CommandResult, { ok: false }>;

/** Defaults for creation when the command gives no style (P5 plan section 14). */
export const DEFAULT_RECTANGLE_FILL = { r: 0.8, g: 0.8, b: 0.8, a: 1 } as const;
export const DEFAULT_PATH_STROKE = {
  color: { r: 0, g: 0, b: 0, a: 1 },
  width: 1,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
} as const;

const ID_ATTEMPTS = 1000;
const PROP_KEYS = ['name', 'fill', 'stroke', 'opacity', 'visible', 'data'] as const;

function fail(code: EditorErrorCode, path?: string): Extract<CommandResult, { ok: false }> {
  return path === undefined ? { ok: false, code } : { ok: false, code, path };
}

function checked(id: string, value: unknown): NodeV1 | Extract<CommandResult, { ok: false }> {
  const result = validateNode(value);
  if (result.ok) return result.node;
  return fail(
    result.code,
    `/nodes/${id.replaceAll('~', '~0').replaceAll('/', '~1')}${result.path}`,
  );
}

function isFailure(
  value: NodeV1 | Extract<CommandResult, { ok: false }>,
): value is Extract<CommandResult, { ok: false }> {
  return 'ok' in value;
}

function freshId(document: DocumentV1, ids: IdSource): string | null {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    const id = ids();
    if (
      typeof id === 'string' &&
      id.length > 0 &&
      id !== document.pages[0].id &&
      !Object.hasOwn(document.nodes, id)
    ) {
      return id;
    }
  }
  return null;
}

function withNodes(
  document: DocumentV1,
  replaced: readonly NodeV1[],
  removed: ReadonlySet<string> = new Set(),
  appended: readonly string[] = [],
): DocumentV1 {
  const nodes: Record<string, NodeV1> = {};
  for (const [id, node] of Object.entries(document.nodes)) {
    if (!removed.has(id))
      Object.defineProperty(nodes, id, {
        value: node,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  for (const node of replaced) {
    Object.defineProperty(nodes, node.id, {
      value: node,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const [page] = document.pages;
  const children =
    removed.size === 0 && appended.length === 0
      ? page.children
      : [...page.children.filter((child) => !removed.has(child)), ...appended];
  return { ...document, pages: [{ ...page, children }], nodes };
}

function uniqueIds(ids: unknown): readonly string[] | null {
  if (!Array.isArray(ids)) return null;
  const seen = new Set<string>();
  for (const id of ids as unknown[]) {
    if (typeof id !== 'string' || seen.has(id)) return null;
    seen.add(id);
  }
  return [...seen];
}

function nodeOf(document: DocumentV1, id: string): NodeV1 | undefined {
  return Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
}

/** Maps page-space points into the unit box of their bounding box (plan section 3.1). */
export function unitBox(points: readonly number[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const unit = points.map((value, index) => {
    const size = index % 2 === 0 ? width : height;
    const origin = index % 2 === 0 ? minX : minY;
    const mapped = size === 0 ? 0 : (value - origin) / size;
    return mapped === 0 ? 0 : mapped;
  });
  return { frame: { x: minX, y: minY, width, height }, unit };
}

export function applyEdit(
  document: DocumentV1,
  command: DocumentCommand,
  ids: IdSource,
): EditResult {
  const [page] = document.pages;
  switch (command.type) {
    case 'createRectangle':
    case 'createPath': {
      const id = freshId(document, ids);
      if (id === null) return fail('editor.duplicate-id');
      let candidate: Record<string, unknown>;
      if (command.type === 'createRectangle') {
        candidate = {
          id,
          name: command.name ?? 'Rectangle',
          parent: page.id,
          frame: command.frame,
          opacity: 1,
          visible: true,
          type: 'rectangle',
          fill: command.fill === undefined ? DEFAULT_RECTANGLE_FILL : command.fill,
          stroke: command.stroke ?? null,
        };
      } else {
        if (!Array.isArray(command.points) || command.points.length < 2) {
          return fail('editor.invalid-command', '/points');
        }
        const { frame, unit } = unitBox(command.points);
        candidate = {
          id,
          name: command.name ?? 'Path',
          parent: page.id,
          frame,
          opacity: 1,
          visible: true,
          type: 'path',
          path: { verbs: command.verbs, points: unit, fillRule: command.fillRule ?? 'nonzero' },
          fill: command.fill ?? null,
          stroke: command.stroke === undefined ? DEFAULT_PATH_STROKE : command.stroke,
        };
      }
      const node = checked(id, candidate);
      if (isFailure(node)) return node;
      return {
        ok: true,
        document: withNodes(document, [node], new Set(), [id]),
        touched: [id],
        created: [id],
      };
    }
    case 'setFrames': {
      const frames: unknown = command.frames;
      if (!Array.isArray(frames)) return fail('editor.invalid-command', '/frames');
      const entries = frames as readonly { id: string; frame: unknown }[];
      const frameIds = uniqueIds(entries.map((entry) => (entry as { id?: unknown } | null)?.id));
      if (frameIds === null) return fail('editor.invalid-command', '/frames');
      const replaced: NodeV1[] = [];
      for (const entry of entries) {
        const node = nodeOf(document, entry.id);
        if (node === undefined) return fail('editor.unknown-node');
        const next = checked(entry.id, { ...node, frame: entry.frame });
        if (isFailure(next)) return next;
        replaced.push(next);
      }
      return { ok: true, document: withNodes(document, replaced), touched: frameIds, created: [] };
    }
    case 'setNodeProps': {
      const node = typeof command.id === 'string' ? nodeOf(document, command.id) : undefined;
      if (node === undefined) return fail('editor.unknown-node');
      const props = command.props as Record<string, unknown> | null;
      if (typeof props !== 'object' || props === null)
        return fail('editor.invalid-command', '/props');
      for (const key of Object.keys(props)) {
        if (!(PROP_KEYS as readonly string[]).includes(key)) {
          return fail('editor.invalid-command', `/props/${key}`);
        }
      }
      if ('data' in props && node.type !== 'custom') {
        return fail('editor.invalid-command', '/props/data');
      }
      const next = checked(node.id, { ...node, ...props });
      if (isFailure(next)) return next;
      return { ok: true, document: withNodes(document, [next]), touched: [node.id], created: [] };
    }
    case 'deleteNodes': {
      const removed = uniqueIds(command.ids);
      if (removed === null || removed.length === 0) return fail('editor.invalid-command', '/ids');
      if (removed.some((id) => nodeOf(document, id) === undefined))
        return fail('editor.unknown-node');
      return {
        ok: true,
        document: withNodes(document, [], new Set(removed)),
        touched: removed,
        created: [],
      };
    }
  }
}
