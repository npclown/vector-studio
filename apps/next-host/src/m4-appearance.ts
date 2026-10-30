import type { Command, StrokePatch, StyleProps } from '@vector-studio/editor-core';
import type {
  Color,
  CornerRadii,
  Gradient,
  GradientSpread,
  NodeV6,
  Paint,
  Stroke,
} from '@vector-studio/model';

// M4-U4 (MVP M4 contract, section 8): the pure side of the next-host appearance panel, unit
// tested without a DOM. The panel reads the selected nodes, shows each field's common value or
// "mixed", and turns one committed edit into one `setStyle` command (one undo step, M4-Q13 (a));
// the editor validates every value. The keys a node type takes mirror editor-core's `PROPS`
// (`setStyle` skips a node without the key, section 4.2).

/** A field's value across the selection: absent (no selected node has it), one value, or mixed. */
export type Common<T> =
  Readonly<{ state: 'none' }> | Readonly<{ state: 'one'; value: T }> | Readonly<{ state: 'mixed' }>;

export type PaintKind = 'none' | 'solid' | 'linear' | 'radial';

/** Section 8: the most stops the panel keeps, `MAX_GRADIENT_STOPS` (M4-S2). */
export const PANEL_MAX_STOPS = 16;
/** M4-S4: the most dash entries. */
export const PANEL_MAX_DASH_ENTRIES = 16;
/** Section 8: the radial preset, centred and filling the unit box. */
export const RADIAL_TRANSFORM: Gradient['transform'] = [0.5, 0, 0, 0.5, 0.5, 0.5];

const FILL_TYPES: ReadonlySet<NodeV6['type']> = new Set([
  'rectangle',
  'ellipse',
  'path',
  'custom',
  'frame',
  'symbol',
]);
const STROKE_TYPES: ReadonlySet<NodeV6['type']> = new Set([...FILL_TYPES, 'line']);

/** The `setStyle` keys a node type takes (editor-core's `PROPS`). */
export function styleKeys(type: NodeV6['type']): readonly (keyof StyleProps)[] {
  const keys: (keyof StyleProps)[] = [];
  if (FILL_TYPES.has(type)) keys.push('fill');
  if (STROKE_TYPES.has(type)) keys.push('stroke');
  keys.push('opacity');
  if (type === 'rectangle') keys.push('cornerRadii');
  return keys;
}

/** Values compare as JSON, the model's normalized form (negative zero is 0 there). */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The common value of `read` over the nodes that take `key`. */
export function common<T>(
  nodes: readonly NodeV6[],
  key: keyof StyleProps,
  read: (node: NodeV6) => T,
): Common<T> {
  let found: { value: T } | null = null;
  for (const node of nodes) {
    if (!styleKeys(node.type).includes(key)) continue;
    const value = read(node);
    if (found === null) found = { value };
    else if (!same(found.value, value)) return { state: 'mixed' };
  }
  return found === null ? { state: 'none' } : { state: 'one', value: found.value };
}

/** A node's fill paint, or null (none, or a type without fill). */
export const fillOf = (node: NodeV6): Paint | null =>
  'fill' in node && FILL_TYPES.has(node.type) ? node.fill : null;

/** A node's stroke, or null. */
export const strokeOf = (node: NodeV6): Stroke | null =>
  'stroke' in node && STROKE_TYPES.has(node.type) ? node.stroke : null;

export const isGradient = (paint: Paint | null): paint is Gradient =>
  paint !== null && 'kind' in paint;

export function paintKind(paint: Paint | null): PaintKind {
  if (paint === null) return 'none';
  return isGradient(paint) ? paint.kind : 'solid';
}

/**
 * The first selected node's paint of `kind` that is a gradient, the "lead" a gradient field edit
 * starts from: one committed value is written to every node (one `setStyle` command), so a field
 * edit across different gradients writes the lead's gradient with the field changed.
 */
export function leadGradient(paints: readonly (Paint | null)[]): Gradient | null {
  for (const paint of paints) if (isGradient(paint)) return paint;
  return null;
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

/** A paint's representative colour: the solid colour, or the first stop's. */
export function leadColor(paint: Paint | null): Color | null {
  if (paint === null) return null;
  return isGradient(paint) ? paint.stops[0]!.color : paint;
}

/**
 * Section 8: linear angle `θ` (radians, clockwise, 0 is left to right) as the transform
 * `[L·cos θ, L·sin θ, −L·sin θ, L·cos θ, ½ − (L/2)·cos θ, ½ − (L/2)·sin θ]`, `L = |cos θ| + |sin θ|`,
 * so `t` runs from 0 to 1 across the unit box.
 */
export function linearTransform(theta: number): Gradient['transform'] {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const length = Math.abs(cos) + Math.abs(sin);
  return [
    length * cos,
    length * sin,
    -length * sin,
    length * cos,
    0.5 - (length / 2) * cos,
    0.5 - (length / 2) * sin,
  ];
}

/** Section 8: the angle the panel shows, `atan2(b, a)` in radians. */
export function linearAngle(transform: Gradient['transform']): number {
  return Math.atan2(transform[1], transform[0]);
}

export const toDegrees = (radians: number) => (radians * 180) / Math.PI;
export const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Section 8: the paint for a kind change. Solid (or none) to a gradient writes two stops, the
 * current colour (opaque black from none) at 0 and the same colour at alpha 0 at 1, spread `pad`;
 * linear at angle 0 or the radial preset. Between gradient kinds the stops and spread are kept
 * and the kind's default transform is written. A gradient to solid keeps its first stop's colour.
 */
export function paintForKind(kind: PaintKind, current: Paint | null): Paint | null {
  if (kind === 'none') return null;
  if (kind === 'solid') return leadColor(current) ?? BLACK;
  const transform = kind === 'linear' ? linearTransform(0) : RADIAL_TRANSFORM;
  if (isGradient(current)) {
    return { kind, transform, stops: current.stops, spread: current.spread };
  }
  const color = current ?? BLACK;
  return {
    kind,
    transform,
    stops: [
      { offset: 0, color },
      { offset: 1, color: { ...color, a: 0 } },
    ],
    spread: 'pad',
  };
}

/** A gradient with stop `index` replaced by `stop`. */
export function withStop(
  gradient: Gradient,
  index: number,
  stop: Partial<Gradient['stops'][number]>,
): Gradient {
  return {
    ...gradient,
    stops: gradient.stops.map((entry, at) => (at === index ? { ...entry, ...stop } : entry)),
  };
}

/**
 * Adds a stop (up to 16): with two or more, at the midpoint of the last two offsets with the
 * colour of the one before the last, inserted before the last; with one, a copy at offset 1.
 */
export function addStop(gradient: Gradient): Gradient {
  const stops = gradient.stops;
  if (stops.length >= PANEL_MAX_STOPS) return gradient;
  if (stops.length === 1) {
    const only = stops[0]!;
    return { ...gradient, stops: [only, { offset: Math.max(only.offset, 1), color: only.color }] };
  }
  const before = stops[stops.length - 2]!;
  const last = stops[stops.length - 1]!;
  const added = { offset: (before.offset + last.offset) / 2, color: before.color };
  return { ...gradient, stops: [...stops.slice(0, -1), added, last] };
}

/** Removes stop `index`; a gradient keeps at least one stop. */
export function removeStop(gradient: Gradient, index: number): Gradient {
  if (gradient.stops.length <= 1) return gradient;
  return { ...gradient, stops: gradient.stops.filter((_, at) => at !== index) };
}

export const withSpread = (gradient: Gradient, spread: GradientSpread): Gradient => ({
  ...gradient,
  spread,
});

/** A colour channel in [0, 1] as two hex digits (rounded to the nearest of 0 to 255). */
const hexByte = (value: number) =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');

/** A colour's RGB as `#rrggbb` (alpha is its own field). */
export function colorHex(color: Color): string {
  return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
}

/** `#rrggbb` (or `rrggbb`, any case) with `alpha` as a colour, or null when it is not one. */
export function parseHex(text: string, alpha: number): Color | null {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(text.trim());
  if (match === null) return null;
  const [r, g, b] = match.slice(1).map((value) => Number.parseInt(value, 16) / 255);
  return { r: r!, g: g!, b: b!, a: alpha };
}

/**
 * A number field's text as a finite number within `[min, max]`, or null. The model checks the
 * value again; the panel only refuses what cannot be one (section 8, `aria-invalid`).
 */
export function parseNumber(text: string, min = -Infinity, max = Infinity): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/**
 * Section 8: a dash pattern as numbers separated by spaces or commas; empty is solid (null).
 * Invalid (M4-S4): an entry that is not a finite number at least 0, more than 16 entries, or no
 * entry above 0.
 */
export function parseDash(text: string): Readonly<{ ok: true; pattern: number[] | null }> | null {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, pattern: null };
  const parts = trimmed.split(/[\s,]+/u).filter((part) => part !== '');
  if (parts.length === 0 || parts.length > PANEL_MAX_DASH_ENTRIES) return null;
  const pattern = parts.map(Number);
  if (pattern.some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (!pattern.some((value) => value > 0)) return null;
  return { ok: true, pattern };
}

/** A pattern as the field shows it. */
export const dashText = (pattern: readonly number[] | null) =>
  pattern === null ? '' : pattern.join(' ');

/**
 * The stroke patch of a dash field edit: a pattern with the lead's phase (0 without one), a
 * phase with the lead's pattern, or `null` (solid) for an empty pattern.
 */
export function dashPatch(
  lead: Stroke['dash'],
  edit: Readonly<{ pattern: number[] | null }> | Readonly<{ phase: number }>,
): StrokePatch {
  if ('pattern' in edit) {
    return {
      dash: edit.pattern === null ? null : { pattern: edit.pattern, phase: lead?.phase ?? 0 },
    };
  }
  return lead === null ? {} : { dash: { pattern: [...lead.pattern], phase: edit.phase } };
}

/**
 * Corner radii after editing corner `index` to `value`: all four when linked, else the lead's
 * radii with that corner changed (one value for the whole selection).
 */
export function radiiFor(
  lead: CornerRadii,
  index: number,
  value: number,
  linked: boolean,
): CornerRadii {
  if (linked) return [value, value, value, value];
  return lead.map((entry, at) => (at === index ? value : entry)) as unknown as CornerRadii;
}

/** One committed panel edit as its one command (section 8). */
export function styleCommand(ids: readonly string[], style: StyleProps): Command {
  return { type: 'setStyle', ids: [...ids], style };
}

/** The ids of the selected nodes that take `key`. */
export function idsTaking(nodes: readonly NodeV6[], key: keyof StyleProps): string[] {
  return nodes.filter((node) => styleKeys(node.type).includes(key)).map((node) => node.id);
}

/** A number as a field shows it: up to 6 decimals, no trailing zeros. */
export function numberText(value: number): string {
  return String(Number(value.toFixed(6)));
}
