import type { Color } from '@vector-studio/model';
import { multiply, type Matrix } from './geometry.js';
import { IDENTITY } from './geometry.js';
import { isElement, type XmlElement } from './svg-xml.js';

// V-33 SVG import contract, V33-M1, M2 and M4: CSS values (colours, lengths, transforms) and the
// style cascade of an SVG element.

// The 148 CSS named colours (CSS Color 4), as name:rrggbb.
const NAMED_SOURCE =
  'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,' +
  'bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,' +
  'burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,' +
  'cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,' +
  'darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,' +
  'darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,' +
  'darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,' +
  'darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,' +
  'deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,' +
  'firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,' +
  'ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,' +
  'grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,' +
  'khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,' +
  'lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,' +
  'lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,' +
  'lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,' +
  'lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,' +
  'magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,' +
  'mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,' +
  'mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,' +
  'mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,' +
  'olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,' +
  'palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,' +
  'peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,' +
  'rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,' +
  'salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,' +
  'skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,' +
  'springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,' +
  'turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,' +
  'yellowgreen:9acd32';

const NAMED: ReadonlyMap<string, string> = new Map(
  NAMED_SOURCE.split(',').map((entry) => entry.split(':') as [string, string]),
);

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function hex(digits: string): Color | null {
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  const expand =
    digits.length === 3 || digits.length === 4
      ? [...digits].map((d) => d + d).join('')
      : digits.length === 6 || digits.length === 8
        ? digits
        : null;
  if (expand === null) return null;
  const byte = (i: number) => Number.parseInt(expand.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: expand.length === 8 ? byte(6) : 1 };
}

/** A number or percentage channel: `%` of 1, else of `scale`. */
function channel(text: string, scale: number): number | null {
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(text)) return null;
  return clamp01(text.endsWith('%') ? value / 100 : value / scale);
}

function hueToRgb(p: number, q: number, t: number): number {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

/**
 * A CSS colour (V33-M4) other than `none`, `currentColor` and `url()`: hex forms, `rgb()`,
 * `rgba()`, `hsl()`, `hsla()`, named colours and `transparent`. Null when not a colour.
 */
export function parseColor(input: string): Color | null {
  const text = input.trim().toLowerCase();
  if (text.startsWith('#')) return hex(text.slice(1));
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED.get(text);
  if (named !== undefined) return hex(named);
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (fn === null) return null;
  const body = fn[2]!.trim();
  let parts: string[];
  let alphaText: string | undefined;
  if (body.includes(',')) {
    parts = body.split(',').map((part) => part.trim());
    if (parts.length === 4) alphaText = parts.pop();
  } else {
    const [main, alpha] = body.split('/').map((part) => part.trim());
    parts = (main ?? '').split(/\s+/);
    alphaText = alpha;
  }
  if (parts.length !== 3) return null;
  const a = alphaText === undefined ? 1 : channel(alphaText, 1);
  if (a === null) return null;
  if (fn[1]!.startsWith('rgb')) {
    const [r, g, b] = parts.map((part) => channel(part, 255));
    if (r === null || g === null || b === null) return null;
    return { r: r!, g: g!, b: b!, a };
  }
  const hue = Number.parseFloat(parts[0]!.replace(/deg$/, ''));
  const s = channel(parts[1]!, 100);
  const l = channel(parts[2]!, 100);
  if (!Number.isFinite(hue) || s === null || l === null) return null;
  const h = (((hue % 360) + 360) % 360) / 360;
  if (s === 0) return { r: l, g: l, b: l, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3),
    g: hueToRgb(p, q, h),
    b: hueToRgb(p, q, h - 1 / 3),
    a,
  };
}

const UNITS: Readonly<Record<string, number>> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

/**
 * A length in user units (V33-M2): a number with an absolute unit, `em` against `fontSize`, or a
 * percentage of `reference`. Null when not a length.
 */
export function parseLength(
  input: string | undefined,
  reference = 0,
  fontSize = 16,
): number | null {
  if (input === undefined) return null;
  const match =
    /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/.exec(
      input,
    );
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] ?? '';
  if (unit === '%') return (value / 100) * reference;
  if (unit === 'em') return value * fontSize;
  if (unit === 'ex') return value * fontSize * 0.5;
  return value * UNITS[unit]!;
}

/** A list of numbers separated by commas and/or space (`points`, `viewBox`, dash arrays). */
export function parseNumberList(input: string | undefined): number[] | null {
  if (input === undefined) return null;
  const text = input.trim();
  if (text === '') return [];
  const parts = text.split(/\s*,\s*|\s+/);
  const values = parts.map((part) => Number(part));
  return values.every((value) => Number.isFinite(value)) && parts.every((p) => p !== '')
    ? values
    : null;
}

/**
 * An SVG `transform` list (V33-M2) as one matrix; an invalid list is the identity (SVG: the
 * attribute is in error and ignored).
 */
export function parseTransform(input: string | undefined): Matrix {
  if (input === undefined) return IDENTITY;
  let result: Matrix = IDENTITY;
  const pattern = /\s*,?\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gy;
  let match: RegExpExecArray | null;
  let at = 0;
  while ((match = pattern.exec(input)) !== null) {
    at = pattern.lastIndex;
    const args = parseNumberList(match[2]);
    if (args === null) return IDENTITY;
    let m: Matrix | null = null;
    switch (match[1]) {
      case 'matrix':
        if (args.length === 6) m = args as unknown as Matrix;
        break;
      case 'translate':
        if (args.length === 1 || args.length === 2) m = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
        break;
      case 'scale':
        if (args.length === 1 || args.length === 2) {
          m = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
        }
        break;
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) break;
        const angle = (args[0]! * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const [cx, cy] = args.length === 3 ? [args[1]!, args[2]!] : [0, 0];
        m = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        break;
      }
      case 'skewX':
        if (args.length === 1) m = [1, 0, Math.tan((args[0]! * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        if (args.length === 1) m = [1, Math.tan((args[0]! * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (m === null) return IDENTITY;
    result = multiply(result, m);
  }
  if (input.slice(at).trim() !== '') return IDENTITY;
  return result;
}

/** The style properties the importer reads (V33-M1). */
export const PROPERTIES = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'display',
  'visibility',
  'clip-path',
  'clip-rule',
  'font-family',
  'font-size',
  'text-anchor',
  'color',
  'stop-color',
  'stop-opacity',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
  'marker',
] as const;

export type Property = (typeof PROPERTIES)[number];
const PROPERTY_SET: ReadonlySet<string> = new Set(PROPERTIES);

export const INHERITED: ReadonlySet<Property> = new Set<Property>([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'clip-rule',
  'visibility',
  'font-family',
  'font-size',
  'text-anchor',
  'color',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

export const INITIAL: Readonly<Record<Property, string>> = {
  fill: 'black',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0',
  'stroke-opacity': '1',
  opacity: '1',
  display: 'inline',
  visibility: 'visible',
  'clip-path': 'none',
  'clip-rule': 'nonzero',
  'font-family': '',
  'font-size': '16',
  'text-anchor': 'start',
  color: 'black',
  'stop-color': 'black',
  'stop-opacity': '1',
  mask: 'none',
  filter: 'none',
  'marker-start': 'none',
  'marker-mid': 'none',
  'marker-end': 'none',
  marker: 'none',
};

/** Declarations of a CSS block body (`a: b; c: d`), lower-cased names, `!important` dropped. */
export function parseDeclarations(body: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim();
    if (name !== '' && value !== '') result.set(name, value);
  }
  return result;
}

/** One compound selector: optional type, ids and classes. */
type Compound = { type: string | null; ids: string[]; classes: string[] };

type Rule = {
  selector: Compound;
  specificity: number;
  order: number;
  declarations: Map<string, string>;
};

function parseCompound(text: string): Compound | null {
  const match = /^([A-Za-z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(text.trim());
  if (match === null || text.trim() === '') return null;
  const ids: string[] = [];
  const classes: string[] = [];
  for (const part of match[2]!.match(/[.#][\w-]+/g) ?? []) {
    (part[0] === '#' ? ids : classes).push(part.slice(1));
  }
  const type = match[1] === undefined || match[1] === '*' ? null : match[1];
  return { type, ids, classes };
}

/** A style sheet of V33-M1 selectors. */
export class StyleSheet {
  private readonly rules: Rule[] = [];
  /** Whether a selector outside the subset was skipped. */
  skippedSelector = false;

  add(css: string): void {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // At-rules with blocks (@media, @font-face, …) are skipped whole.
    let depth = 0;
    let at = 0;
    let start = 0;
    let skipping = false;
    let prelude = '';
    while (at < text.length) {
      const character = text[at]!;
      if (character === '{') {
        if (depth === 0) {
          prelude = text.slice(start, at).trim();
          skipping = prelude.startsWith('@');
          start = at + 1;
        }
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          if (!skipping) this.addRule(prelude, text.slice(start, at));
          else this.skippedSelector = true;
          start = at + 1;
        }
        if (depth < 0) return;
      } else if (character === ';' && depth === 0) {
        start = at + 1; // @import and @charset
      }
      at += 1;
    }
  }

  private addRule(prelude: string, body: string): void {
    const declarations = parseDeclarations(body);
    for (const part of prelude.split(',')) {
      const selector = parseCompound(part);
      if (selector === null) {
        this.skippedSelector = true;
        continue;
      }
      const specificity =
        selector.ids.length * 10_000 + selector.classes.length * 100 + (selector.type ? 1 : 0);
      this.rules.push({ selector, specificity, order: this.rules.length, declarations });
    }
  }

  /** The declarations that match `element`, later and more specific ones last. */
  matching(element: XmlElement): Map<string, string>[] {
    const name = localName(element.name);
    const id = element.attributes.get('id');
    const classes = (element.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
    return this.rules
      .filter(({ selector }) => {
        if (selector.type !== null && selector.type !== name) return false;
        if (selector.ids.some((value) => value !== id)) return false;
        return selector.classes.every((value) => classes.includes(value));
      })
      .sort((a, b) => a.specificity - b.specificity || a.order - b.order)
      .map((rule) => rule.declarations);
  }
}

/** The element name without an `svg:` prefix; other prefixes are kept. */
export function localName(name: string): string {
  return name.startsWith('svg:') ? name.slice(4) : name;
}

/** The computed style of one element. */
export type Style = Readonly<Record<Property, string>>;

/**
 * The computed style of `element` under `parent` (V33-M1): its `style` attribute, then the sheet's
 * matching rules, then its presentation attributes, then inheritance, then the initial value.
 */
export function computeStyle(element: XmlElement, parent: Style | null, sheet: StyleSheet): Style {
  const declared = new Map<string, string>();
  for (const [key, value] of element.attributes) {
    if (PROPERTY_SET.has(key)) declared.set(key, value.trim());
  }
  for (const rule of sheet.matching(element)) {
    for (const [key, value] of rule) declared.set(key, value);
  }
  const inline = element.attributes.get('style');
  if (inline !== undefined) {
    for (const [key, value] of parseDeclarations(inline)) declared.set(key, value);
  }
  const style = {} as Record<Property, string>;
  for (const property of PROPERTIES) {
    const value = declared.get(property);
    const inherited = parent?.[property];
    if (value === undefined || value === 'inherit') {
      style[property] =
        inherited !== undefined && (INHERITED.has(property) || value === 'inherit')
          ? inherited
          : INITIAL[property];
    } else if (value === 'initial') style[property] = INITIAL[property];
    else style[property] = value;
  }
  // font-size is computed to user units here, so `em` children see a number.
  const size = parseLength(
    style['font-size'],
    parent ? Number(parent['font-size']) : 16,
    parent ? Number(parent['font-size']) : 16,
  );
  // A size of 0 is kept (the text draws nothing); a negative or invalid one inherits.
  style['font-size'] = String(
    size !== null && size >= 0 ? size : parent ? parent['font-size'] : 16,
  );
  return style;
}

/** Every element of the tree in document order. */
export function* elements(root: XmlElement): Generator<XmlElement> {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop()!;
    yield element;
    for (let i = element.children.length - 1; i >= 0; i -= 1) {
      const child = element.children[i]!;
      if (isElement(child)) stack.push(child);
    }
  }
}
