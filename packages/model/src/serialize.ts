import type { Dash, DocumentV6, JsonValue, NodeV6, Paint, Stroke, TextRun } from './types.js';

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

/** A colour as `r, g, b, a`; a gradient as `kind, transform, stops, spread` (M4 section 2). */
function paint(value: Paint): Ordered {
  if (!('kind' in value)) return color(value);
  return {
    kind: value.kind,
    transform: [...value.transform],
    stops: value.stops.map((stop) => ({ offset: stop.offset, color: color(stop.color) })),
    spread: value.spread,
  };
}

function dash(value: Dash): Ordered {
  return { pattern: [...value.pattern], phase: value.phase };
}

function stroke(value: Stroke): Ordered {
  return {
    color: paint(value.color),
    width: value.width,
    cap: value.cap,
    join: value.join,
    miterLimit: value.miterLimit,
    dash: nullable(value.dash, dash),
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

/** Fields after `type` of path and custom nodes. */
function pathFields(value: Extract<NodeV6, { type: 'path' | 'custom' }>): Ordered {
  if (value.type === 'path') {
    return {
      path: {
        verbs: [...value.path.verbs],
        points: [...value.path.points],
        fillRule: value.path.fillRule,
      },
      fill: nullable(value.fill, paint),
      stroke: nullable(value.stroke, stroke),
    };
  }
  return {
    customType: value.customType,
    data: json(value.data),
    fill: nullable(value.fill, paint),
    stroke: nullable(value.stroke, stroke),
  };
}

function frame(value: { x: number; y: number; width: number; height: number }): Ordered {
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function runs(value: readonly TextRun[]): Ordered[] {
  return value.map((run) => ({
    text: run.text,
    family: run.family,
    size: run.size,
    color: color(run.color),
  }));
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nodeV6(value: NodeV6): Ordered {
  const base = {
    id: value.id,
    name: value.name,
    parent: value.parent,
    frame: frame(value.frame),
    rotation: value.rotation,
    constraints: {
      horizontal: value.constraints.horizontal,
      vertical: value.constraints.vertical,
    },
    opacity: value.opacity,
    visible: value.visible,
    type: value.type,
  };
  switch (value.type) {
    case 'rectangle':
      return {
        ...base,
        cornerRadii: [...value.cornerRadii],
        fill: nullable(value.fill, paint),
        stroke: nullable(value.stroke, stroke),
      };
    case 'ellipse':
      return {
        ...base,
        fill: nullable(value.fill, paint),
        stroke: nullable(value.stroke, stroke),
      };
    case 'line':
      return {
        ...base,
        points: [...value.points],
        stroke: nullable(value.stroke, stroke),
        startArrow: value.startArrow,
        endArrow: value.endArrow,
      };
    case 'path':
    case 'custom':
      return { ...base, ...pathFields(value) };
    case 'group':
    case 'maskGroup':
      return { ...base, children: [...value.children] };
    case 'frame':
    case 'symbol':
      return {
        ...base,
        children: [...value.children],
        fill: nullable(value.fill, paint),
        stroke: nullable(value.stroke, stroke),
      };
    case 'instance':
      return {
        ...base,
        symbol: value.symbol,
        // Code unit order, with the node map's caveat above: array-index-like keys come first.
        textOverrides: Object.fromEntries(
          Object.keys(value.textOverrides)
            .sort(compareCodeUnits)
            .map((key) => [key, { runs: runs(value.textOverrides[key]!.runs) }]),
        ),
      };
    case 'text':
      return {
        ...base,
        runs: runs(value.runs),
        sizing: value.sizing,
        align: value.align,
        letterSpacing: value.letterSpacing,
        lineHeight: value.lineHeight,
      };
  }
}

/**
 * The document as a plain object in canonical key order, for `serializeDocument` and the
 * persistence envelope (MVP M5 contract, M5-E3). Not exported from the package.
 */
export function orderedDocument(document: DocumentV6): Ordered {
  return {
    schemaVersion: document.schemaVersion,
    id: document.id,
    pages: document.pages.map((page) => ({
      id: page.id,
      name: page.name,
      children: [...page.children],
    })),
    nodes: Object.fromEntries(
      Object.keys(document.nodes)
        .sort(compareCodeUnits)
        .map((key) => [key, nodeV6(document.nodes[key]!)]),
    ),
  };
}

/**
 * Emits canonical schema v6 JSON (M1 contract, section 2.1; M7 contract, section 2.1; M6a
 * contract, sections 2 and 9; M4 contract, section 2): two-space indentation, fixed key order and
 * a final newline. A paint is written as a colour (`r, g, b, a`) or a gradient (`kind`,
 * `transform`, `stops`, each `offset`, `color`, then `spread`), a stroke as `color`, `width`,
 * `cap`, `join`, `miterLimit`, `dash` (`null` or `pattern`, `phase`). A
 * symbol's keys are in a frame's order, an instance's in the base order followed by `symbol` and
 * `textOverrides` (its keys in code unit order, each value `{ runs }`), a text
 * node's in the base order followed by `runs` (each `text`, `family`, `size`, `color`),
 * `sizing`, `align`, `letterSpacing`, `lineHeight`.
 */
export function serializeDocument(document: DocumentV6): string {
  return `${JSON.stringify(orderedDocument(document), null, 2)}\n`;
}
