// V-33 SVG import contract (docs/plans/viz-v33-svg-import-contract.md), V33-C3: the XML subset an
// SVG file needs, without a DOM, so that `editor-core` keeps running in any JavaScript runtime.
// Elements, attributes in either quote, character data, CDATA, comments, processing instructions
// and a DOCTYPE without an internal subset; the predefined entities and character references.

/** An element: its qualified name, attributes in document order and children. */
export type XmlElement = {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
};

/** Character data (text and CDATA), entity references decoded. */
export type XmlText = { readonly text: string };

export type XmlNode = XmlElement | XmlText;

export const isElement = (node: XmlNode): node is XmlElement => 'name' in node;

/** V33-C2 limits. */
export const MAX_SVG_LENGTH = 8 * 1024 * 1024;
export const MAX_SVG_DEPTH = 256;
export const MAX_SVG_ELEMENTS = 20_000;

/** A parse failure; the converter reports every one as `editor.invalid-svg`. */
export class XmlError extends Error {}

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/;
const SPACE = /[ \t\r\n]/;

/** Decodes the entity and character references of `raw` (attribute value or character data). */
function decode(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s]*);?/g, (match, body: string) => {
    if (!match.endsWith(';')) throw new XmlError('unterminated reference');
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      if (!/^[0-9a-fA-F]+$/.test(body.slice(2)) || code > 0x10ffff) {
        throw new XmlError('bad reference');
      }
      return String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      if (!/^[0-9]+$/.test(body.slice(1)) || code > 0x10ffff) throw new XmlError('bad reference');
      return String.fromCodePoint(code);
    }
    const value = PREDEFINED[body];
    if (value === undefined) throw new XmlError(`unknown entity ${body}`);
    return value;
  });
}

class Reader {
  at = 0;
  elements = 0;
  constructor(readonly text: string) {}

  fail(message: string): never {
    throw new XmlError(`${message} at ${this.at}`);
  }

  startsWith(value: string): boolean {
    return this.text.startsWith(value, this.at);
  }

  skipSpace(): void {
    while (this.at < this.text.length && SPACE.test(this.text[this.at]!)) this.at += 1;
  }

  /** Skips to just after `end`, failing when it never comes. */
  skipPast(end: string): string {
    const index = this.text.indexOf(end, this.at);
    if (index < 0) this.fail(`missing ${end}`);
    const body = this.text.slice(this.at, index);
    this.at = index + end.length;
    return body;
  }

  name(): string {
    const start = this.at;
    if (!NAME_START.test(this.text[this.at] ?? '')) this.fail('expected a name');
    this.at += 1;
    while (this.at < this.text.length && NAME_CHAR.test(this.text[this.at]!)) this.at += 1;
    return this.text.slice(start, this.at);
  }

  /** Comments, processing instructions and a DOCTYPE before or after the root, and space. */
  misc(allowDoctype: boolean): void {
    for (;;) {
      this.skipSpace();
      if (this.startsWith('<!--')) {
        this.at += 4;
        this.skipPast('-->');
      } else if (this.startsWith('<?')) {
        this.at += 2;
        this.skipPast('?>');
      } else if (allowDoctype && this.startsWith('<!DOCTYPE')) {
        this.doctype();
      } else return;
    }
  }

  /** A DOCTYPE with an external ID at most; an internal subset is refused (V33-C2). */
  doctype(): void {
    this.at += '<!DOCTYPE'.length;
    let quote: string | null = null;
    while (this.at < this.text.length) {
      const character = this.text[this.at]!;
      this.at += 1;
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '[') this.fail('DOCTYPE internal subset');
      else if (character === '>') return;
    }
    this.fail('unterminated DOCTYPE');
  }

  element(depth: number): XmlElement {
    if (depth > MAX_SVG_DEPTH) this.fail('too deep');
    this.elements += 1;
    if (this.elements > MAX_SVG_ELEMENTS) this.fail('too many elements');
    this.at += 1; // '<'
    const name = this.name();
    const attributes = new Map<string, string>();
    for (;;) {
      const before = this.at;
      this.skipSpace();
      if (this.startsWith('/>')) {
        this.at += 2;
        return { name, attributes, children: [] };
      }
      if (this.startsWith('>')) {
        this.at += 1;
        break;
      }
      if (this.at === before) this.fail('expected space before an attribute');
      const key = this.name();
      this.skipSpace();
      if (this.text[this.at] !== '=') this.fail('expected =');
      this.at += 1;
      this.skipSpace();
      const quote = this.text[this.at];
      if (quote !== '"' && quote !== "'") this.fail('expected a quoted value');
      this.at += 1;
      const raw = this.skipPast(quote);
      if (raw.includes('<')) this.fail('< in an attribute value');
      if (attributes.has(key)) this.fail(`duplicate attribute ${key}`);
      // Attribute value normalization: whitespace characters become spaces.
      attributes.set(key, decode(raw).replace(/[\t\r\n]/g, ' '));
    }
    const children: XmlNode[] = [];
    for (;;) {
      if (this.at >= this.text.length) this.fail(`unclosed <${name}>`);
      if (this.startsWith('</')) {
        this.at += 2;
        const end = this.name();
        if (end !== name) this.fail(`</${end}> closes <${name}>`);
        this.skipSpace();
        if (this.text[this.at] !== '>') this.fail('expected >');
        this.at += 1;
        return { name, attributes, children };
      }
      if (this.startsWith('<!--')) {
        this.at += 4;
        this.skipPast('-->');
      } else if (this.startsWith('<![CDATA[')) {
        this.at += 9;
        children.push({ text: this.skipPast(']]>') });
      } else if (this.startsWith('<?')) {
        this.at += 2;
        this.skipPast('?>');
      } else if (this.startsWith('<!')) {
        this.fail('unexpected declaration');
      } else if (this.startsWith('<')) {
        children.push(this.element(depth + 1));
      } else {
        const next = this.text.indexOf('<', this.at);
        const end = next < 0 ? this.text.length : next;
        children.push({ text: decode(this.text.slice(this.at, end)) });
        this.at = end;
      }
    }
  }
}

/**
 * Parses `text` as one XML document and returns its document element. Throws `XmlError` for text
 * that is not well-formed within the subset, a DOCTYPE internal subset, or the V33-C2 limits.
 */
export function parseXml(text: string): XmlElement {
  if (text.length > MAX_SVG_LENGTH) throw new XmlError('too long');
  const reader = new Reader(text.startsWith('﻿') ? text.slice(1) : text);
  reader.misc(true);
  if (reader.text[reader.at] !== '<') reader.fail('expected the root element');
  const root = reader.element(0);
  reader.misc(false);
  if (reader.at !== reader.text.length) reader.fail('content after the root element');
  return root;
}

/**
 * V33-C4: whether the first element of `text`, after an optional BOM, space, an XML declaration,
 * comments and a DOCTYPE, is `svg` (or `svg:svg`). It reads only the prologue.
 */
export function isSvgText(text: string): boolean {
  const reader = new Reader(text.startsWith('﻿') ? text.slice(1) : text);
  try {
    reader.misc(true);
    if (reader.text[reader.at] !== '<') return false;
    reader.at += 1;
    const name = reader.name();
    if (name !== 'svg' && name !== 'svg:svg') return false;
    const next = reader.text[reader.at];
    return next === undefined || next === '>' || next === '/' || SPACE.test(next);
  } catch {
    return false;
  }
}
