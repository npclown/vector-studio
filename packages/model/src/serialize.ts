import type { DocumentV1, JsonValue, NodeV1, PathStroke, RectStroke } from './types.js';

// Fixed key order (plan section 3.3). Node and custom-data keys are inserted in code-unit order,
// so the text does not depend on the order nodes were created, deleted or restored in. (Object
// property order still lists array-index-like keys first, in numeric order; that is also fixed.)

type Ordered = { [key: string]: unknown };

function color(value: { r: number; g: number; b: number; a: number }): Ordered {
  return { r: value.r, g: value.g, b: value.b, a: value.a };
}

function nullable<T>(value: T | null, map: (value: T) => Ordered): Ordered | null {
  return value === null ? null : map(value);
}

function rectStroke(value: RectStroke): Ordered {
  return { color: color(value.color), width: value.width };
}

function pathStroke(value: PathStroke): Ordered {
  return {
    color: color(value.color),
    width: value.width,
    cap: value.cap,
    join: value.join,
    miterLimit: value.miterLimit,
  };
}

function json(value: JsonValue): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(json);
  const record = value as { readonly [key: string]: JsonValue };
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareCodeUnits)
      .map((key) => [key, json(record[key]!)]),
  );
}

function node(value: NodeV1): Ordered {
  const base = {
    id: value.id,
    name: value.name,
    parent: value.parent,
    frame: {
      x: value.frame.x,
      y: value.frame.y,
      width: value.frame.width,
      height: value.frame.height,
    },
    opacity: value.opacity,
    visible: value.visible,
    type: value.type,
  };
  switch (value.type) {
    case 'rectangle':
      return {
        ...base,
        fill: nullable(value.fill, color),
        stroke: nullable(value.stroke, rectStroke),
      };
    case 'path':
      return {
        ...base,
        path: {
          verbs: [...value.path.verbs],
          points: [...value.path.points],
          fillRule: value.path.fillRule,
        },
        fill: nullable(value.fill, color),
        stroke: nullable(value.stroke, pathStroke),
      };
    case 'custom':
      return {
        ...base,
        customType: value.customType,
        data: json(value.data),
        fill: nullable(value.fill, color),
        stroke: nullable(value.stroke, pathStroke),
      };
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Emits canonical JSON: two-space indentation, fixed key order and a final newline. */
export function serializeDocument(document: DocumentV1): string {
  const [page] = document.pages;
  const ordered = {
    schemaVersion: document.schemaVersion,
    id: document.id,
    pages: [{ id: page.id, name: page.name, children: [...page.children] }],
    nodes: Object.fromEntries(
      Object.keys(document.nodes)
        .sort(compareCodeUnits)
        .map((key) => [key, node(document.nodes[key]!)]),
    ),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
