import {
  MAX_DASH_ENTRIES,
  MAX_GRADIENT_STOPS,
  MAX_TEXT_LENGTH,
  type Color,
  type FillRule,
  type Frame,
  type Gradient,
  type GradientStop,
  type Paint,
  type PathVerb,
  type Stroke,
  type StrokeCap,
  type StrokeJoin,
} from '@vector-studio/model';
import { fail, type Failure } from './draft.js';
import {
  boundsOfPoints,
  corners,
  fitPoints,
  localTransform,
  multiply,
  IDENTITY,
} from './geometry.js';
import type { Matrix } from './geometry.js';
import { normalizeInputText } from './text-input.js';
import { FRAGMENT_MARKER } from './clipboard.js';
import {
  ellipseOutline,
  emptyOutline,
  outlineBounds,
  parsePathData,
  polyOutline,
  rectOutline,
  transformOutline,
  type Outline,
} from './svg-path-data.js';
import {
  computeStyle,
  elements,
  localName,
  parseColor,
  parseLength,
  parseNumberList,
  parseDeclarations,
  parseTransform,
  StyleSheet,
  type Style,
} from './svg-style.js';
import { isElement, parseXml, XmlError, type XmlElement, type XmlNode } from './svg-xml.js';

// V-33 SVG import contract (docs/plans/viz-v33-svg-import-contract.md), sections 2 and 3: an SVG
// document to clipboard fragment text, whose paste (M2 section 6) inserts it as editable nodes.

/** One text run as the converter asks the layout to measure it. */
export type SvgTextRun = Readonly<{ text: string; family: string; size: number }>;

/** The size and first baseline of an `autoWidth` text node of `runs` (V33-C1). */
export type SvgTextMeasure = Readonly<{ width: number; height: number; baseline: number }>;

/** Options of `svgToFragment` (V33-C1). */
export type SvgImportOptions = Readonly<{
  /** Lays out an `autoWidth`, left-aligned text node of `runs` at line height 1.2. */
  layout?: (runs: readonly SvgTextRun[]) => SvgTextMeasure;
  /** The wrapping group's name when the SVG has no `<title>` (a file name). */
  name?: string;
  /** The family of text with no family or only generic ones. */
  defaultFamily?: string;
}>;

/** A successful conversion (V33-C1). */
export type SvgImport = Readonly<{
  ok: true;
  fragment: string;
  /** Dropped element and property names, once each, in first-seen order (V33-M8). */
  skipped: readonly string[];
  /** Whether a text node was imported (the paste then needs a layout port). */
  hasText: boolean;
}>;

/** V33-C2 limits. */
export const MAX_SVG_NODES = 10_000;
const MAX_NODE_DEPTH = 200;
const MAX_USE_DEPTH = 32;
/** Elements visited while converting (`<use>` copies included), so fan-out over empty leaves is bounded. */
const MAX_VISITS = 200_000;
/** Path points emitted (clip outlines included), so references cannot multiply the output. */
export const MAX_SVG_POINTS = 1_000_000;
/** Text code units emitted, so text copied through `<use>` cannot multiply the output. */
export const MAX_SVG_TEXT = 1_000_000;
const TEXT_LINE_HEIGHT = 1.2;
const MAX_TEXT_SIZE = 4096;
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const START = { horizontal: 'start', vertical: 'start' } as const;

/** Elements that draw nothing themselves and are not reported (V33-M7). */
const SILENT: ReadonlySet<string> = new Set([
  'defs',
  'symbol',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'style',
  'title',
  'desc',
  'metadata',
  'stop',
]);

/** A converted node in page space; containers hold their children. */
type Converted =
  | {
      kind: 'path';
      name: string;
      frame: Frame;
      unit: number[];
      verbs: PathVerb[];
      fillRule: FillRule;
      fill: Paint | null;
      stroke: Stroke | null;
      opacity: number;
    }
  | {
      kind: 'rectangle' | 'ellipse';
      name: string;
      frame: Frame;
      rotation: number;
      radius: number;
      fill: Paint | null;
      stroke: Stroke | null;
      opacity: number;
    }
  | {
      kind: 'text';
      name: string;
      frame: Frame;
      rotation: number;
      runs: { text: string; family: string; size: number; color: Color }[];
      align: 'left' | 'center' | 'right';
      opacity: number;
    }
  | { kind: 'group' | 'maskGroup'; name: string; children: Converted[]; opacity: number };

class TooLarge extends Error {}

/** The general inverse of an affine map, or null when it is singular or not finite. */
function invert(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const inverse: Matrix = [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
  return inverse.every(Number.isFinite) ? inverse : null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function parseOpacity(value: string): number {
  const text = value.trim();
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return 1;
  return clamp01(text.endsWith('%') ? number / 100 : number);
}

const withAlpha = (color: Color, alpha: number): Color => ({
  r: color.r,
  g: color.g,
  b: color.b,
  a: clamp01(color.a * alpha),
});

/** `url(#id) fallback` parts, or null. */
function parseUrl(value: string): { id: string; fallback: string } | null {
  const match = /^url\(\s*(['"]?)#([^'")]+)\1\s*\)\s*(.*)$/.exec(value.trim());
  return match === null ? null : { id: match[2]!, fallback: match[3]!.trim() };
}

/** The `href` of an element (`href` or `xlink:href`), as an id without `#`, or null. */
function hrefId(element: XmlElement): string | null {
  const href = element.attributes.get('href') ?? element.attributes.get('xlink:href');
  return href?.startsWith('#') === true ? href.slice(1) : null;
}

/**
 * The viewport map of `viewBox` into a `width` × `height` viewport at `(x, y)` under
 * `preserveAspectRatio` (SVG 1.1, 7.8).
 */
function viewportMap(
  viewBox: number[] | null,
  par: string | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): Matrix {
  if (viewBox === null || viewBox.length !== 4 || !(viewBox[2]! > 0) || !(viewBox[3]! > 0)) {
    return [1, 0, 0, 1, x, y];
  }
  const [vx, vy, vw, vh] = viewBox as [number, number, number, number];
  let sx = width / vw;
  let sy = height / vh;
  const parts = (par ?? 'xMidYMid meet').trim().split(/\s+/);
  const align = parts[0] === 'defer' ? (parts[1] ?? 'xMidYMid') : parts[0]!;
  const slice = parts.includes('slice');
  if (align !== 'none') {
    const scale = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = scale;
    sy = scale;
  }
  let tx = x - vx * sx;
  let ty = y - vy * sy;
  if (align !== 'none') {
    if (align.includes('xMid')) tx += (width - vw * sx) / 2;
    if (align.includes('xMax')) tx += width - vw * sx;
    if (align.includes('YMid')) ty += (height - vh * sy) / 2;
    if (align.includes('YMax')) ty += height - vh * sy;
  }
  return [sx, 0, 0, sy, tx, ty];
}

class Converter {
  private readonly ids = new Map<string, XmlElement>();
  private readonly sheet = new StyleSheet();
  private readonly skippedNames: string[] = [];
  private count = 0;
  private visits = 0;
  private points = 0;
  private textUnits = 0;
  /** Layouts by run content: `<use>` copies of one text measure once. */
  private readonly measured = new Map<string, SvgTextMeasure>();
  /** The root viewport's normalized diagonal, the reference of percentage stroke lengths. */
  private diagonal = 100;
  private readonly parents = new Map<XmlElement, XmlElement>();
  private hasText = false;
  private readonly useStack: string[] = [];

  constructor(
    private readonly root: XmlElement,
    private readonly options: SvgImportOptions,
  ) {
    for (const element of elements(root)) {
      for (const child of element.children) if (isElement(child)) this.parents.set(child, element);
      const id = element.attributes.get('id');
      if (id !== undefined && !this.ids.has(id)) this.ids.set(id, element);
      if (localName(element.name) === 'style') {
        this.sheet.add(textOf(element));
      }
    }
  }

  skip(name: string): void {
    if (!this.skippedNames.includes(name)) this.skippedNames.push(name);
  }

  /** Spends `count` points of the V33-C2 point budget. */
  private spend(count: number): void {
    this.points += count;
    if (this.points > MAX_SVG_POINTS) throw new TooLarge();
  }

  private counted(): void {
    this.count += 1;
    if (this.count > MAX_SVG_NODES) throw new TooLarge();
  }

  run(): { roots: Converted[]; skipped: string[]; hasText: boolean } {
    const style = computeStyle(this.root, null, this.sheet);
    const attributes = this.root.attributes;
    const viewBox = parseNumberList(attributes.get('viewBox'));
    const box = viewBox !== null && viewBox.length === 4 ? viewBox : null;
    const width = parseLength(attributes.get('width'), box?.[2] ?? 100) ?? box?.[2] ?? 100;
    const height = parseLength(attributes.get('height'), box?.[3] ?? 100) ?? box?.[3] ?? 100;
    const ctm = viewportMap(box, attributes.get('preserveAspectRatio'), 0, 0, width, height);
    const viewport = { width: box?.[2] ?? width, height: box?.[3] ?? height };
    this.diagonal = Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
    const children = this.children(this.root, ctm, style, viewport, 0);
    if (this.sheet.skippedSelector) this.skip('css-selector');
    let roots = children;
    if (children.length > 1) {
      const title = this.root.children.find(
        (child) => isElement(child) && localName(child.name) === 'title',
      ) as XmlElement | undefined;
      const titleText = title === undefined ? '' : textOf(title).trim();
      const name = titleText !== '' ? titleText : (this.options.name ?? 'SVG');
      roots = [{ kind: 'group', name: name.slice(0, 1000), children, opacity: 1 }];
    }
    // The root's own opacity and clip (its viewport is not a clip, V33-M2).
    const opacity = parseOpacity(style.opacity);
    if (roots.length === 1 && opacity < 1) {
      const only = roots[0]!;
      roots = [
        only.kind === 'group' && only.opacity === 1
          ? { ...only, opacity }
          : { kind: 'group', name: 'SVG', children: [only], opacity },
      ];
    }
    if (roots.length === 1 && style['clip-path'] !== 'none') {
      const clipped = this.clipPath(
        roots[0]!,
        style['clip-path'],
        ctm,
        this.root,
        style,
        viewport,
        'SVG',
      );
      roots = clipped === null ? [] : [clipped];
    }
    return { roots, skipped: this.skippedNames, hasText: this.hasText };
  }

  private children(
    element: XmlElement,
    ctm: Matrix,
    style: Style,
    viewport: { width: number; height: number },
    depth: number,
  ): Converted[] {
    const out: Converted[] = [];
    for (const child of element.children) {
      if (!isElement(child)) continue;
      const node = this.element(child, ctm, style, viewport, depth);
      if (node !== null) out.push(node);
    }
    return out;
  }

  private element(
    element: XmlElement,
    parentCtm: Matrix,
    parentStyle: Style,
    viewport: { width: number; height: number },
    depth: number,
    styleOverride?: Style,
  ): Converted | null {
    if (depth > MAX_NODE_DEPTH) throw new TooLarge();
    this.visits += 1;
    if (this.visits > MAX_VISITS) throw new TooLarge();
    const name = localName(element.name);
    if (name.includes(':')) return null; // another namespace's element, skipped with its content
    if (SILENT.has(name)) return null;
    const style = styleOverride ?? computeStyle(element, parentStyle, this.sheet);
    if (style.display.trim() === 'none') return null;
    for (const property of ['mask', 'filter'] as const) {
      if (style[property] !== 'none') this.skip(property);
    }
    for (const property of ['marker-start', 'marker-mid', 'marker-end', 'marker'] as const) {
      if (style[property] !== 'none') this.skip('marker');
    }
    const ctm = multiply(parentCtm, parseTransform(element.attributes.get('transform')));
    const label = element.attributes.get('id') ?? element.attributes.get('inkscape:label') ?? name;
    let node: Converted | null;
    switch (name) {
      case 'g':
      case 'a':
      case 'switch': {
        const children = this.children(element, ctm, style, viewport, depth + 1);
        node = this.group(label, children, style);
        break;
      }
      case 'svg': {
        const length = (key: string, ref: number, fallback: number) =>
          parseLength(element.attributes.get(key), ref) ?? fallback;
        const x = length('x', viewport.width, 0);
        const y = length('y', viewport.height, 0);
        const width = length('width', viewport.width, viewport.width);
        const height = length('height', viewport.height, viewport.height);
        if (!(width > 0) || !(height > 0)) return null;
        const viewBox = parseNumberList(element.attributes.get('viewBox'));
        const inner = multiply(
          ctm,
          viewportMap(viewBox, element.attributes.get('preserveAspectRatio'), x, y, width, height),
        );
        const size =
          viewBox !== null && viewBox.length === 4
            ? { width: viewBox[2]!, height: viewBox[3]! }
            : { width, height };
        const children = this.children(element, inner, style, size, depth + 2);
        const group = this.group(label, children, style);
        node =
          group === null
            ? null
            : this.clipped(
                group,
                transformOutline(rectOutline(x, y, width, height, 0, 0), ctm),
                'nonzero',
                label,
              );
        break;
      }
      case 'use':
        node = this.use(element, ctm, style, viewport, depth);
        break;
      case 'text':
        node =
          style.visibility === 'hidden' ? null : this.text(element, ctm, style, label, viewport);
        break;
      case 'path':
      case 'rect':
      case 'circle':
      case 'ellipse':
      case 'line':
      case 'polyline':
      case 'polygon':
        // Children of a shape (animation elements, `<title>`) draw nothing; report them.
        for (const child of element.children) {
          if (!isElement(child)) continue;
          const childName = localName(child.name);
          if (childName !== 'title' && childName !== 'desc') this.skip(childName);
        }
        node =
          style.visibility === 'hidden'
            ? null
            : this.shape(name, element, ctm, style, viewport, label);
        break;
      default:
        this.skip(name);
        return null;
    }
    if (node === null) return null;
    const clip = style['clip-path'];
    if (clip !== 'none') node = this.clipPath(node, clip, ctm, element, style, viewport, label);
    return node;
  }

  private group(name: string, children: Converted[], style: Style): Converted | null {
    if (children.length === 0) return null;
    const opacity = parseOpacity(style.opacity);
    if (children.length === 1 && opacity === 1) return children[0]!;
    this.counted();
    return { kind: 'group', name, children, opacity };
  }

  /** `node` inside a mask group whose mask is `outline` (page space). */
  private clipped(
    node: Converted,
    outline: Outline,
    rule: FillRule,
    name: string,
  ): Converted | null {
    const mask = this.pathNode(`${name} clip`, outline, rule, BLACK, null, 1, false);
    if (mask === null) return null;
    this.counted();
    return { kind: 'maskGroup', name, children: [mask, node], opacity: 1 };
  }

  private clipPath(
    node: Converted,
    value: string,
    ctm: Matrix,
    element: XmlElement,
    style: Style,
    viewport: { width: number; height: number },
    name: string,
  ): Converted | null {
    const url = parseUrl(value);
    const clip = url === null ? undefined : this.ids.get(url.id);
    if (clip === undefined || localName(clip.name) !== 'clipPath') return null;
    let space = ctm;
    if (clip.attributes.get('clipPathUnits') === 'objectBoundingBox') {
      const bounds = this.userBounds(element, style, viewport);
      if (bounds === null || !(bounds.width > 0) || !(bounds.height > 0)) return null;
      space = multiply(space, [bounds.width, 0, 0, bounds.height, bounds.x, bounds.y]);
    }
    space = multiply(space, parseTransform(clip.attributes.get('transform')));
    const clipStyle = computeStyle(clip, style, this.sheet);
    const outline = emptyOutline();
    let rule: FillRule = 'nonzero';
    let shapes = 0;
    for (const child of clip.children) {
      if (!isElement(child)) continue;
      this.visits += 1;
      if (this.visits > MAX_VISITS) throw new TooLarge();
      const childName = localName(child.name);
      const childStyle = computeStyle(child, clipStyle, this.sheet);
      if (childStyle.display === 'none' || childStyle.visibility === 'hidden') continue;
      if (childStyle['clip-path'] !== 'none') this.skip('clip-path');
      const geometry = this.geometry(childName, child, viewport);
      if (geometry === null) {
        if (childName !== 'title' && childName !== 'desc') this.skip(childName);
        continue;
      }
      const mapped = transformOutline(
        geometry,
        multiply(space, parseTransform(child.attributes.get('transform'))),
      );
      // Counted here and not again by the mask's pathNode below.
      this.spend(mapped.points.length / 2);
      for (const verb of mapped.verbs) outline.verbs.push(verb);
      for (const value of mapped.points) outline.points.push(value);
      rule = childStyle['clip-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
      shapes += 1;
    }
    if (shapes === 0) return null;
    if (clip.attributes.has('clip-path') || clipStyle['clip-path'] !== 'none')
      this.skip('clip-path');
    return this.clipped(node, outline, shapes === 1 ? rule : 'nonzero', name);
  }

  private use(
    element: XmlElement,
    ctm: Matrix,
    style: Style,
    viewport: { width: number; height: number },
    depth: number,
  ): Converted | null {
    const id = hrefId(element);
    const target = id === null ? undefined : this.ids.get(id);
    if (id === null || target === undefined) return null;
    if (this.useStack.includes(id) || this.useStack.length >= MAX_USE_DEPTH) return null;
    const x = parseLength(element.attributes.get('x'), viewport.width) ?? 0;
    const y = parseLength(element.attributes.get('y'), viewport.height) ?? 0;
    const placed = multiply(ctm, [1, 0, 0, 1, x, y]);
    this.useStack.push(id);
    try {
      if (localName(target.name) === 'symbol') {
        const symbolStyle = computeStyle(target, style, this.sheet);
        if (symbolStyle.display === 'none') return null;
        const viewBox = parseNumberList(target.attributes.get('viewBox'));
        const box = viewBox !== null && viewBox.length === 4 ? viewBox : null;
        const width =
          parseLength(element.attributes.get('width'), viewport.width) ?? viewport.width;
        const height =
          parseLength(element.attributes.get('height'), viewport.height) ?? viewport.height;
        const inner = multiply(
          placed,
          viewportMap(box, target.attributes.get('preserveAspectRatio'), 0, 0, width, height),
        );
        const children = this.children(
          target,
          inner,
          symbolStyle,
          box === null ? viewport : { width: box[2]!, height: box[3]! },
          depth + 1,
        );
        const symbol = this.group(target.attributes.get('id') ?? 'symbol', children, symbolStyle);
        return symbol === null ? null : this.withOpacity(symbol, element, style);
      }
      const node = this.element(target, placed, style, viewport, depth + 1);
      return node === null ? null : this.withOpacity(node, element, style);
    } finally {
      this.useStack.pop();
    }
  }

  /** `node` in a group carrying the `<use>`'s own opacity, when it has one below 1. */
  private withOpacity(node: Converted, element: XmlElement, style: Style): Converted {
    const opacity = parseOpacity(style.opacity);
    if (opacity === 1) return node;
    this.counted();
    return {
      kind: 'group',
      name: element.attributes.get('id') ?? 'use',
      children: [node],
      opacity,
    };
  }

  /** The user-space outline of a basic shape or path element, or null for other elements. */
  private geometry(
    name: string,
    element: XmlElement,
    viewport: { width: number; height: number },
  ): Outline | null {
    const a = element.attributes;
    const diagonal = Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
    const len = (key: string, ref: number) => parseLength(a.get(key), ref) ?? 0;
    switch (name) {
      case 'path':
        return parsePathData(a.get('d') ?? '');
      case 'rect': {
        const x = len('x', viewport.width);
        const y = len('y', viewport.height);
        const width = len('width', viewport.width);
        const height = len('height', viewport.height);
        if (!(width > 0) || !(height > 0)) return emptyOutline();
        const [rx, ry] = this.radii(element, viewport, width, height);
        return rectOutline(x, y, width, height, rx, ry);
      }
      case 'circle': {
        const r = len('r', diagonal);
        if (!(r > 0)) return emptyOutline();
        return ellipseOutline(len('cx', viewport.width), len('cy', viewport.height), r, r);
      }
      case 'ellipse': {
        const rx = len('rx', viewport.width);
        const ry = len('ry', viewport.height);
        if (!(rx > 0) || !(ry > 0)) return emptyOutline();
        return ellipseOutline(len('cx', viewport.width), len('cy', viewport.height), rx, ry);
      }
      case 'line':
        return polyOutline(
          [
            len('x1', viewport.width),
            len('y1', viewport.height),
            len('x2', viewport.width),
            len('y2', viewport.height),
          ],
          false,
        );
      case 'polyline':
      case 'polygon': {
        const values = parseNumberList(a.get('points')?.replace(/(\d)-/g, '$1 -')) ?? [];
        const even = values.slice(0, values.length - (values.length % 2));
        return polyOutline(even, name === 'polygon');
      }
      default:
        return null;
    }
  }

  /** A rect's corner radii after SVG's auto and clamping rules. */
  private radii(
    element: XmlElement,
    viewport: { width: number; height: number },
    width: number,
    height: number,
  ): [number, number] {
    const rxValue = parseLength(element.attributes.get('rx'), viewport.width);
    const ryValue = parseLength(element.attributes.get('ry'), viewport.height);
    let rx = rxValue !== null && rxValue >= 0 ? rxValue : null;
    let ry = ryValue !== null && ryValue >= 0 ? ryValue : null;
    if (rx === null) rx = ry ?? 0;
    if (ry === null) ry = rx;
    return [Math.min(rx, width / 2), Math.min(ry, height / 2)];
  }

  /** The user-space bounds of an element's geometry (for `objectBoundingBox`). */
  private userBounds(
    element: XmlElement,
    style: Style,
    viewport: { width: number; height: number },
  ): Frame | null {
    const name = localName(element.name);
    const geometry = this.geometry(name, element, viewport);
    if (geometry !== null) return outlineBounds(geometry);
    // A container: the union of its shapes' bounds in its own user space.
    const points: { x: number; y: number }[] = [];
    for (const child of element.children) {
      if (!isElement(child)) continue;
      const bounds = this.userBounds(child, style, viewport);
      if (bounds === null) continue;
      const m = parseTransform(child.attributes.get('transform'));
      const outline = transformOutline(
        polyOutline(
          [
            bounds.x,
            bounds.y,
            bounds.x + bounds.width,
            bounds.y,
            bounds.x + bounds.width,
            bounds.y + bounds.height,
            bounds.x,
            bounds.y + bounds.height,
          ],
          true,
        ),
        m,
      );
      for (let i = 0; i < outline.points.length; i += 2) {
        points.push({ x: outline.points[i]!, y: outline.points[i + 1]! });
      }
    }
    return boundsOfPoints(points);
  }

  private shape(
    name: string,
    element: XmlElement,
    ctm: Matrix,
    style: Style,
    viewport: { width: number; height: number },
    label: string,
  ): Converted | null {
    const geometry = this.geometry(name, element, viewport);
    if (geometry === null || geometry.verbs.length === 0) return null;
    const bounds = outlineBounds(geometry);
    const opacity = parseOpacity(style.opacity);
    const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
    const open = name === 'line' || name === 'polyline';
    const fillValue = open && name === 'line' ? 'none' : style.fill;
    const [a, b, c, d] = ctm;
    const axisAligned = b === 0 && c === 0 && a !== 0 && d !== 0;
    const similarity =
      Math.abs(Math.abs(a) - Math.abs(d)) <= 1e-12 * Math.abs(a) &&
      Math.abs(Math.abs(b) - Math.abs(c)) <= 1e-12 * Math.abs(a || b) &&
      (Math.abs(a - d) <= 1e-12 * Math.abs(a || b)
        ? Math.abs(b + c) <= 1e-12 * Math.abs(a || b)
        : Math.abs(b - c) <= 1e-12 * Math.abs(a || b)) &&
      scale > 0;
    // Rectangles and ellipses as their own node types when the CTM keeps them (V33-M3).
    if (
      (name === 'rect' || name === 'circle' || name === 'ellipse') &&
      bounds !== null &&
      (axisAligned || similarity)
    ) {
      const user = bounds;
      let frame: Frame;
      let rotation = 0;
      let sx: number;
      let sy: number;
      if (axisAligned) {
        sx = Math.abs(a);
        sy = Math.abs(d);
        const x0 = a * user.x + ctm[4];
        const x1 = a * (user.x + user.width) + ctm[4];
        const y0 = d * user.y + ctm[5];
        const y1 = d * (user.y + user.height) + ctm[5];
        frame = {
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
          width: Math.abs(x1 - x0),
          height: Math.abs(y1 - y0),
        };
      } else {
        sx = scale;
        sy = scale;
        rotation = Math.atan2(b, a);
        const cx = user.x + user.width / 2;
        const cy = user.y + user.height / 2;
        const centre = { x: a * cx + c * cy + ctm[4], y: b * cx + d * cy + ctm[5] };
        const width = user.width * scale;
        const height = user.height * scale;
        frame = { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
      }
      let radius = 0;
      let ok = true;
      if (name === 'rect') {
        const [rx, ry] = this.radii(element, viewport, user.width, user.height);
        if (rx > 0 && ry > 0) {
          radius = rx * sx;
          ok = Math.abs(rx * sx - ry * sy) <= 1e-9 * Math.max(1, radius);
        }
      }
      if (ok && frame.width > 0 && frame.height > 0) {
        const unit = multiply(localTransform(frame, rotation), [
          frame.width,
          0,
          0,
          frame.height,
          0,
          0,
        ]);
        const fill = this.paint(fillValue, style['fill-opacity'], style, ctm, user, unit);
        const stroke = this.stroke(style, ctm, scale, user, unit);
        if (fill === null && stroke === null) return null;
        this.counted();
        return {
          kind: name === 'rect' ? 'rectangle' : 'ellipse',
          name: label,
          frame,
          rotation: rotation === 0 ? 0 : rotation,
          radius,
          fill,
          stroke,
          opacity,
        };
      }
    }
    const mapped = transformOutline(geometry, ctm);
    const fit = fitPoints(mapped.points, 0);
    const unit =
      invert([fit.frame.width, 0, 0, fit.frame.height, fit.frame.x, fit.frame.y]) === null
        ? null
        : ([fit.frame.width, 0, 0, fit.frame.height, fit.frame.x, fit.frame.y] as Matrix);
    const fill = this.paint(fillValue, style['fill-opacity'], style, ctm, bounds, unit);
    const stroke = this.stroke(style, ctm, scale, bounds, unit);
    // A path that draws nothing: no area for a fill alone, no extent at all (V33-M3).
    if (fit.frame.width === 0 && fit.frame.height === 0) return null;
    if (stroke === null && (fit.frame.width === 0 || fit.frame.height === 0)) return null;
    if (fill === null && stroke === null) return null;
    const rule: FillRule = style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
    return this.pathNode(label, mapped, rule, fill, stroke, opacity);
  }

  /** A path node from a page-space outline, or null when it has no segment. */
  private pathNode(
    name: string,
    outline: Outline,
    fillRule: FillRule,
    fill: Paint | null,
    stroke: Stroke | null,
    opacity: number,
    spend = true,
  ): Converted | null {
    if (outline.verbs.length === 0 || !outline.points.every(Number.isFinite)) return null;
    if (spend) this.spend(outline.points.length / 2);
    const fit = fitPoints(outline.points, 0);
    this.counted();
    return {
      kind: 'path',
      name,
      frame: fit.frame,
      unit: fit.unit,
      verbs: outline.verbs,
      fillRule,
      fill,
      stroke,
      opacity,
    };
  }

  /** A paint value (V33-M4) for a node whose unit box maps to page space by `unit`. */
  private paint(
    value: string,
    opacityValue: string,
    style: Style,
    ctm: Matrix,
    bounds: Frame | null,
    unit: Matrix | null,
  ): Paint | null {
    const alpha = parseOpacity(opacityValue);
    const text = value.trim();
    if (text === 'none') return null;
    if (text.toLowerCase() === 'currentcolor') {
      return withAlpha(parseColor(style.color) ?? BLACK, alpha);
    }
    const url = parseUrl(text);
    if (url !== null) {
      const target = this.ids.get(url.id);
      const kind = target === undefined ? '' : localName(target.name);
      if (kind === 'linearGradient' || kind === 'radialGradient') {
        return this.gradient(target!, alpha, ctm, bounds, unit);
      }
      if (kind === 'pattern') this.skip('pattern');
      return url.fallback === '' || url.fallback === 'none'
        ? null
        : this.paint(url.fallback, opacityValue, style, ctm, bounds, unit);
    }
    const color = parseColor(text);
    return color === null ? null : withAlpha(color, alpha);
  }

  /** The value of a gradient attribute, following `href` (at most 16 links). */
  private gradientAttribute(element: XmlElement, key: string): string | undefined {
    let current: XmlElement | undefined = element;
    for (let i = 0; i < 16 && current !== undefined; i += 1) {
      const value = current.attributes.get(key);
      if (value !== undefined) return value;
      const next = hrefId(current);
      current = next === null ? undefined : this.ids.get(next);
    }
    return undefined;
  }

  /** The stops of a gradient, following `href` until an element has stops. */
  private gradientStops(element: XmlElement, alpha: number): GradientStop[] {
    let current: XmlElement | undefined = element;
    for (let i = 0; i < 16 && current !== undefined; i += 1) {
      const stops = current.children.filter(
        (child): child is XmlElement => isElement(child) && localName(child.name) === 'stop',
      );
      if (stops.length > 0) {
        const gradientStyle = computeStyle(current, null, this.sheet);
        let last = 0;
        return stops.map((stop) => {
          const style = computeStyle(stop, gradientStyle, this.sheet);
          const raw = (stop.attributes.get('offset') ?? '0').trim();
          let offset = Number.parseFloat(raw);
          if (!Number.isFinite(offset)) offset = 0;
          if (raw.endsWith('%')) offset /= 100;
          offset = Math.max(last, clamp01(offset));
          last = offset;
          const colorText = style['stop-color'].trim();
          const color =
            colorText.toLowerCase() === 'currentcolor'
              ? (parseColor(style.color) ?? BLACK)
              : (parseColor(colorText) ?? BLACK);
          return { offset, color: withAlpha(color, parseOpacity(style['stop-opacity']) * alpha) };
        });
      }
      const next = hrefId(current);
      current = next === null ? undefined : this.ids.get(next);
    }
    return [];
  }

  private gradient(
    element: XmlElement,
    alpha: number,
    ctm: Matrix,
    bounds: Frame | null,
    unit: Matrix | null,
  ): Paint | null {
    let stops = this.gradientStops(element, alpha);
    if (stops.length === 0) return null;
    if (stops.length === 1) return stops[0]!.color;
    if (stops.length > MAX_GRADIENT_STOPS) {
      const all = stops;
      stops = Array.from(
        { length: MAX_GRADIENT_STOPS },
        (_, i) => all[Math.round((i * (all.length - 1)) / (MAX_GRADIENT_STOPS - 1))]!,
      );
    }
    const last = stops[stops.length - 1]!.color;
    const linear = localName(element.name) === 'linearGradient';
    const units = this.gradientAttribute(element, 'gradientUnits') ?? 'objectBoundingBox';
    const bbox = units !== 'userSpaceOnUse';
    const number = (key: string, fallback: number) => {
      const raw = this.gradientAttribute(element, key);
      if (raw === undefined) return fallback;
      const text = raw.trim();
      if (bbox && text.endsWith('%')) return Number.parseFloat(text) / 100;
      return parseLength(text, this.diagonal) ?? fallback;
    };
    let space: Matrix;
    if (linear) {
      const x1 = number('x1', 0);
      const y1 = number('y1', 0);
      const x2 = number('x2', bbox ? 1 : 100);
      const y2 = number('y2', 0);
      const dx = x2 - x1;
      const dy = y2 - y1;
      if (dx === 0 && dy === 0) return last;
      space = [dx, dy, -dy, dx, x1, y1];
    } else {
      const cx = number('cx', bbox ? 0.5 : 50);
      const cy = number('cy', bbox ? 0.5 : 50);
      const r = number('r', bbox ? 0.5 : 50);
      if (!(r > 0)) return last;
      if (
        this.gradientAttribute(element, 'fx') !== undefined ||
        this.gradientAttribute(element, 'fy') !== undefined
      ) {
        this.skip('focal-point');
      }
      space = [r, 0, 0, r, cx, cy];
    }
    space = multiply(parseTransform(this.gradientAttribute(element, 'gradientTransform')), space);
    if (bbox) {
      if (bounds === null || !(bounds.width > 0) || !(bounds.height > 0)) return last;
      space = multiply([bounds.width, 0, 0, bounds.height, bounds.x, bounds.y], space);
    }
    const inverse = unit === null ? null : invert(unit);
    if (inverse === null) return last;
    const transform = multiply(inverse, multiply(ctm, space));
    if (!transform.every(Number.isFinite) || invert(transform) === null) return last;
    const spreadValue = this.gradientAttribute(element, 'spreadMethod');
    const spread = spreadValue === 'reflect' || spreadValue === 'repeat' ? spreadValue : 'pad';
    const gradient: Gradient = {
      kind: linear ? 'linear' : 'radial',
      transform: transform,
      stops,
      spread,
    };
    return gradient;
  }

  private stroke(
    style: Style,
    ctm: Matrix,
    scale: number,
    bounds: Frame | null,
    unit: Matrix | null,
  ): Stroke | null {
    const color = this.paint(style.stroke, style['stroke-opacity'], style, ctm, bounds, unit);
    if (color === null) return null;
    const width = (parseLength(style['stroke-width'], this.diagonal) ?? 1) * scale;
    if (!(width > 0) || !Number.isFinite(width)) return null;
    const cap: StrokeCap =
      style['stroke-linecap'] === 'round' || style['stroke-linecap'] === 'square'
        ? style['stroke-linecap']
        : 'butt';
    const joinValue = style['stroke-linejoin'];
    const join: StrokeJoin = joinValue === 'round' || joinValue === 'bevel' ? joinValue : 'miter';
    if (joinValue !== 'miter' && joinValue !== 'round' && joinValue !== 'bevel')
      this.skip('stroke-linejoin');
    const limit = Number.parseFloat(style['stroke-miterlimit']);
    const miterLimit = Number.isFinite(limit) && limit >= 1 ? limit : 4;
    return { color, width, cap, join, miterLimit, dash: this.dash(style, scale) };
  }

  private dash(style: Style, scale: number): Stroke['dash'] {
    const text = style['stroke-dasharray'].trim();
    if (text === 'none') return null;
    const parts = text.split(/\s*,\s*|\s+/).map((part) => parseLength(part, this.diagonal));
    if (parts.some((part) => part === null || part < 0)) return null;
    let pattern = parts as number[];
    if (pattern.length % 2 === 1) pattern = [...pattern, ...pattern];
    if (pattern.length === 0 || !pattern.some((value) => value > 0)) return null;
    if (pattern.length > MAX_DASH_ENTRIES) {
      this.skip('stroke-dasharray');
      return null;
    }
    const phase = (parseLength(style['stroke-dashoffset'], this.diagonal) ?? 0) * scale;
    return {
      pattern: pattern.map((value) => value * scale),
      phase: Number.isFinite(phase) ? phase : 0,
    };
  }

  private text(
    element: XmlElement,
    ctm: Matrix,
    style: Style,
    label: string,
    viewport: { width: number; height: number },
  ): Converted | null {
    type Piece = { text: string; family: string; size: number; color: Color; newline: boolean };
    const pieces: Piece[] = [];
    let anchor: { x: number; y: number } | null = null;
    let lineY: number | null = null;
    // The first value of an `x` or `y` list, with units and percentages of the viewport.
    const first = (value: string | undefined, reference: number) => {
      const head = value?.trim().split(/\s*,\s*|\s+/)[0];
      return head === undefined || head === '' ? null : parseLength(head, reference);
    };
    const visit = (node: XmlElement, nodeStyle: Style, preserve: boolean) => {
      for (const child of node.children) {
        if (!isElement(child)) {
          pieces.push({
            ...this.runStyle(nodeStyle),
            text: collapse(child.text, preserve),
            newline: false,
          });
          continue;
        }
        const name = localName(child.name);
        if (name !== 'tspan') {
          if (name !== 'title' && name !== 'desc') this.skip(name);
          continue;
        }
        const childStyle = computeStyle(child, nodeStyle, this.sheet);
        if (childStyle.display === 'none') continue;
        this.styleSkips(child, childStyle);
        const x = first(child.attributes.get('x'), viewport.width);
        const y = first(child.attributes.get('y'), viewport.height);
        if (anchor === null && (x !== null || y !== null)) {
          anchor = { x: x ?? 0, y: y ?? 0 };
          lineY = y;
        } else if (y !== null && lineY !== null && y !== lineY) {
          pieces.push({ ...this.runStyle(childStyle), text: '', newline: true });
          lineY = y;
        }
        const space = child.attributes.get('xml:space');
        visit(child, childStyle, space === undefined ? preserve : space === 'preserve');
      }
    };
    const x = first(element.attributes.get('x'), viewport.width);
    const y = first(element.attributes.get('y'), viewport.height);
    if (x !== null || y !== null) {
      anchor = { x: x ?? 0, y: y ?? 0 };
      lineY = y;
    }
    visit(element, style, this.xmlSpace(element) === 'preserve');
    this.styleSkips(element, style);
    if (style.stroke !== 'none') this.skip('text-stroke');
    // Join pieces: default whitespace collapses across pieces and trims the ends.
    const preserve = this.xmlSpace(element) === 'preserve';
    const runs: { text: string; family: string; size: number; color: Color }[] = [];
    let total = '';
    for (const piece of pieces) {
      let text = piece.newline ? '\n' : piece.text;
      if (!preserve && !piece.newline) {
        if ((total.endsWith(' ') || total === '' || total.endsWith('\n')) && text.startsWith(' ')) {
          text = text.slice(1);
        }
      }
      if (text === '' || piece.size <= 0) continue;
      total += text;
      const last = runs[runs.length - 1];
      if (
        last !== undefined &&
        last.family === piece.family &&
        last.size === piece.size &&
        sameColor(last.color, piece.color)
      ) {
        last.text += text;
      } else runs.push({ text, family: piece.family, size: piece.size, color: piece.color });
    }
    if (!preserve) {
      while (runs.length > 0 && runs[runs.length - 1]!.text.endsWith(' ')) {
        const last = runs[runs.length - 1]!;
        last.text = last.text.slice(0, -1);
        if (last.text === '') runs.pop();
      }
    }
    // M6b 9.1 normalization per run, then the length cut.
    let remaining = MAX_TEXT_LENGTH;
    const normalized: typeof runs = [];
    for (const run of runs) {
      const text = normalizeInputText(run.text).slice(0, remaining);
      if (text === '') continue;
      remaining -= text.length;
      normalized.push({ ...run, text });
      if (remaining <= 0) break;
    }
    if (normalized.length === 0) return null;
    const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
    if (!(scale > 0)) return null;
    const sized = normalized.map((run) => ({
      ...run,
      size: Math.min(MAX_TEXT_SIZE, run.size * scale),
    }));
    const merged: typeof sized = [];
    for (const run of sized) {
      const last = merged[merged.length - 1];
      if (
        last !== undefined &&
        last.family === run.family &&
        last.size === run.size &&
        sameColor(last.color, run.color)
      ) {
        last.text += run.text;
      } else merged.push({ ...run });
    }
    for (const run of merged) this.textUnits += run.text.length;
    if (this.textUnits > MAX_SVG_TEXT) throw new TooLarge();
    const key = JSON.stringify(merged);
    let measure = this.measured.get(key);
    if (measure === undefined) {
      measure = this.measure(merged);
      this.measured.set(key, measure);
    }
    const anchorValue = style['text-anchor'].trim();
    const k = anchorValue === 'middle' ? 0.5 : anchorValue === 'end' ? 1 : 0;
    const align = k === 0.5 ? 'center' : k === 1 ? 'right' : 'left';
    const at = anchor ?? { x: 0, y: 0 };
    const page = {
      x: ctm[0] * at.x + ctm[2] * at.y + ctm[4],
      y: ctm[1] * at.x + ctm[3] * at.y + ctm[5],
    };
    const [a, b, c, d] = ctm;
    const similarity =
      Math.abs(Math.abs(a) - Math.abs(d)) <= 1e-12 * scale &&
      Math.abs(Math.abs(b) - Math.abs(c)) <= 1e-12 * scale &&
      a * d - b * c > 0;
    const rotation = similarity ? Math.atan2(b, a) : 0;
    const { width, height, baseline } = measure;
    // The frame whose local anchor (k·w, baseline) lands on `page` (V33-M6).
    const half = { x: width / 2, y: height / 2 };
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const lx = k * width - half.x;
    const ly = baseline - half.y;
    const frame = {
      x: page.x - half.x - (lx * cos - ly * sin),
      y: page.y - half.y - (lx * sin + ly * cos),
      width,
      height,
    };
    if (!Object.values(frame).every(Number.isFinite)) return null;
    this.hasText = true;
    this.counted();
    return {
      kind: 'text',
      name: label,
      frame,
      rotation,
      runs: merged,
      align,
      opacity: parseOpacity(style.opacity),
    };
  }

  /** Reports the text styles the model cannot hold (V33-M6), declared on `element` by any source. */
  private styleSkips(element: XmlElement, style: Style): void {
    for (const property of ['font-weight', 'font-style', 'text-decoration'] as const) {
      // The nearest declaration on the element or an ancestor (the properties inherit).
      let value: string | undefined;
      for (
        let at: XmlElement | undefined = element;
        at !== undefined && (value === undefined || value === 'inherit');
      ) {
        value = declaredValue(at, property, this.sheet);
        at = this.parents.get(at);
      }
      if (value !== undefined && value !== 'normal' && value !== 'none' && value !== '400') {
        this.skip(property);
      }
    }
    if (style.stroke !== 'none') this.skip('text-stroke');
  }

  /** The inherited `xml:space` of `element`. */
  private xmlSpace(element: XmlElement): string {
    for (let at: XmlElement | undefined = element; at !== undefined; at = this.parents.get(at)) {
      const value = at.attributes.get('xml:space');
      if (value !== undefined) return value;
    }
    return 'default';
  }

  private runStyle(style: Style): { family: string; size: number; color: Color } {
    const families = cssFamilies(style['font-family']);
    const firstFamily = families[0];
    const family =
      firstFamily === undefined || GENERIC_FAMILIES.has(firstFamily.toLowerCase())
        ? (this.options.defaultFamily ?? 'Arial')
        : firstFamily.slice(0, 128);
    const size = Number(style['font-size']);
    // A gradient fill takes its first stop (V33-M6); text colour is solid.
    const url = parseUrl(style.fill);
    const target = url === null ? undefined : this.ids.get(url.id);
    const kind = target === undefined ? '' : localName(target.name);
    const stops =
      kind === 'linearGradient' || kind === 'radialGradient'
        ? this.gradientStops(target!, parseOpacity(style['fill-opacity']))
        : [];
    const fill =
      stops.length > 0
        ? stops[0]!.color
        : this.paint(style.fill, style['fill-opacity'], style, IDENTITY, null, null);
    const color =
      fill === null ? { r: 0, g: 0, b: 0, a: 0 } : 'kind' in fill ? fill.stops[0]!.color : fill;
    return { family, size: Number.isFinite(size) ? size : 16, color };
  }

  private measure(runs: readonly SvgTextRun[]): SvgTextMeasure {
    if (this.options.layout !== undefined) return this.options.layout(runs);
    const size = runs.reduce((most, run) => Math.max(most, run.size), -Infinity);
    const lines = runs
      .map((run) => run.text)
      .join('')
      .split('\n');
    const longest = lines.reduce((most, line) => Math.max(most, line.length), -Infinity);
    return {
      width: Math.max(1, 0.6 * size * longest),
      height: TEXT_LINE_HEIGHT * size * lines.length,
      baseline: 0.8 * size,
    };
  }
}

/** The families of a CSS `font-family` list, quotes removed, case kept. */
function cssFamilies(list: string): string[] {
  const out: string[] = [];
  for (const match of list.matchAll(
    /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,]+))\s*(?:,|$)/g,
  )) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1').trim();
    if (value !== '') out.push(value);
  }
  return out;
}

function sameColor(a: Color, b: Color): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** The concatenated character data of an element's subtree. */
function textOf(element: XmlElement): string {
  return element.children
    .map((child: XmlNode) => (isElement(child) ? textOf(child) : child.text))
    .join('');
}

/** SVG 1.1 10.15 white space handling of one piece of character data. */
function collapse(text: string, preserve: boolean): string {
  if (preserve) return text.replace(/[\r\n\t]/g, ' ');
  return text.replace(/\r?\n/g, '').replace(/\t/g, ' ').replace(/ {2,}/g, ' ');
}

/** The value of `property` declared on `element` by its style attribute, a sheet rule or an attribute. */
function declaredValue(
  element: XmlElement,
  property: string,
  sheet: StyleSheet,
): string | undefined {
  const inline = parseDeclarations(element.attributes.get('style') ?? '').get(property);
  if (inline !== undefined) return inline.trim();
  let fromSheet: string | undefined;
  for (const rule of sheet.matching(element)) fromSheet = rule.get(property) ?? fromSheet;
  return fromSheet?.trim() ?? element.attributes.get(property)?.trim();
}

/** The fragment node objects of converted roots (V33-M5 group frames, IDs `n1`, `n2`, …). */
function emit(roots: readonly Converted[]): { roots: string[]; nodes: Record<string, unknown> } {
  const nodes: Record<string, unknown> = {};
  let next = 0;
  // Returns the node's ID and its page-space frame and rotation.
  const write = (
    node: Converted,
    parent: string,
    origin: { x: number; y: number },
    depth: number,
  ): { id: string; frame: Frame; rotation: number } => {
    if (depth > MAX_NODE_DEPTH) throw new TooLarge();
    next += 1;
    const id = `n${next}`;
    const base = {
      id,
      name: node.name.slice(0, 1000),
      parent,
      rotation: 0,
      constraints: START,
      opacity: node.opacity,
      visible: true,
      effects: [],
    };
    const local = (frame: Frame) => ({ ...frame, x: frame.x - origin.x, y: frame.y - origin.y });
    switch (node.kind) {
      case 'path':
        nodes[id] = {
          ...base,
          frame: local(node.frame),
          type: 'path',
          path: { verbs: node.verbs, points: node.unit, fillRule: node.fillRule },
          fill: node.fill,
          stroke: node.stroke,
        };
        return { id, frame: node.frame, rotation: 0 };
      case 'rectangle':
        nodes[id] = {
          ...base,
          frame: local(node.frame),
          rotation: node.rotation,
          type: 'rectangle',
          cornerRadii: [node.radius, node.radius, node.radius, node.radius],
          fill: node.fill,
          stroke: node.stroke,
        };
        return { id, frame: node.frame, rotation: node.rotation };
      case 'ellipse':
        nodes[id] = {
          ...base,
          frame: local(node.frame),
          rotation: node.rotation,
          type: 'ellipse',
          fill: node.fill,
          stroke: node.stroke,
        };
        return { id, frame: node.frame, rotation: node.rotation };
      case 'text':
        nodes[id] = {
          ...base,
          frame: local(node.frame),
          rotation: node.rotation,
          type: 'text',
          runs: node.runs,
          sizing: 'autoWidth',
          align: node.align,
          letterSpacing: 0,
          lineHeight: TEXT_LINE_HEIGHT,
        };
        return { id, frame: node.frame, rotation: node.rotation };
      case 'group':
      case 'maskGroup': {
        // The frame is the bounds of the children's frame corners (V33-M5); children are
        // written first in page space, then moved into the group's space.
        const placed = node.children.map((child) => write(child, id, { x: 0, y: 0 }, depth + 1));
        const frame = boundsOfPoints(
          placed.flatMap((child) => corners(child.frame, child.rotation)),
        )!;
        for (const child of placed) {
          const entry = nodes[child.id] as { frame: Frame };
          entry.frame = { ...entry.frame, x: entry.frame.x - frame.x, y: entry.frame.y - frame.y };
        }
        nodes[id] = {
          ...base,
          frame: local(frame),
          type: node.kind,
          children: placed.map((child) => child.id),
        };
        return { id, frame, rotation: 0 };
      }
    }
  };
  const ids = roots.map((root) => write(root, '', { x: 0, y: 0 }, 1).id);
  return { roots: ids, nodes };
}

/**
 * V33-C1: converts SVG text into clipboard fragment text (version 2, schema 7) whose roots are
 * the drawn content in page space, or fails with `editor.invalid-svg` (V33-C2: not well-formed,
 * not an SVG, an entity DOCTYPE, the size, depth and node limits) or `editor.empty-svg` (nothing
 * drawn).
 */
export function svgToFragment(text: string, options: SvgImportOptions = {}): SvgImport | Failure {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (error) {
    if (error instanceof XmlError) return fail('editor.invalid-svg');
    throw error;
  }
  if (localName(root.name) !== 'svg') return fail('editor.invalid-svg');
  let converted: ReturnType<Converter['run']>;
  let emitted: ReturnType<typeof emit>;
  try {
    converted = new Converter(root, options).run();
    if (converted.roots.length === 0) return fail('editor.empty-svg');
    emitted = emit(converted.roots);
  } catch (error) {
    if (error instanceof TooLarge) return fail('editor.invalid-svg');
    throw error;
  }
  const body = JSON.stringify({
    fragmentVersion: 2,
    schemaVersion: 7,
    roots: emitted.roots,
    nodes: emitted.nodes,
    sources: [],
    sourceNodes: {},
  });
  return {
    ok: true,
    fragment: `${FRAGMENT_MARKER}\n${body}`,
    skipped: converted.skipped,
    hasText: converted.hasText,
  };
}

export { isSvgText } from './svg-xml.js';
