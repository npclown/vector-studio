import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type ExportNode,
  type ExportScene,
  type Stroke,
} from '../../packages/editor-core/src/index.js';
import { svgNumber } from '../../packages/editor-core/src/export.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// V-30 export contract (docs/plans/viz-v30-export-contract.md): V30-A01 to A03.

const RED = { r: 1, g: 0, b: 0, a: 1 } as const;
const BLUE = { r: 0, g: 0, b: 1, a: 0.5 } as const;

function editor(withText = false): Editor {
  return createEditor({
    ids: createCounterIdSource('n'),
    ...(withText ? { textLayout: createFakeTextLayout() } : {}),
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function stroke(width: number, extra: Partial<Stroke> = {}): Stroke {
  return { color: RED, width, cap: 'butt', join: 'miter', miterLimit: 4, dash: null, ...extra };
}

function scene(target: Editor, ids?: readonly string[]): ExportScene {
  const result = target.query(
    ids === undefined ? { type: 'exportScene' } : { type: 'exportScene', ids },
  );
  expect(result).not.toBeNull();
  return result!;
}

function node(value: ExportScene, id: string): ExportNode {
  const found = value.nodes.get(id);
  expect(found, id).toBeDefined();
  return found!;
}

/**
 * A minimal well-formedness check (no XML parser in the workspace): balanced tags, quoted
 * attributes, and text and attribute values without a raw `<` or a bare `&`. Returns the
 * elements in document order with their attributes and direct text.
 */
type Element = { name: string; attributes: Record<string, string>; text: string };
function parseSvg(text: string): Element[] {
  const elements: Element[] = [];
  const stack: Element[] = [];
  const entity = /&(amp|lt|gt|quot|apos);/g;
  const token = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gy;
  let match: RegExpExecArray | null;
  let at = 0;
  while ((match = token.exec(text)) !== null) {
    at = token.lastIndex;
    const [, closing, name, attrs, selfClosing, chars] = match;
    if (chars !== undefined) {
      expect(chars.replace(entity, '')).not.toMatch(/[<&]/);
      if (stack.length > 0) stack[stack.length - 1]!.text += chars;
      else expect(chars.trim()).toBe('');
      continue;
    }
    if (closing === '/') {
      expect(stack.pop()?.name).toBe(name);
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const [, key, value] of attrs!.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      expect(value!.replace(entity, '')).not.toMatch(/&/);
      expect(attributes[key!]).toBeUndefined();
      attributes[key!] = value!
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
    }
    const element = { name: name!, attributes, text: '' };
    elements.push(element);
    if (selfClosing !== '/') stack.push(element);
  }
  expect(at).toBe(text.length);
  expect(stack).toEqual([]);
  expect(elements[0]?.name).toBe('svg');
  return elements;
}

function unescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('V30-A01 export scene roots and content', () => {
  it('exports the page, in paint order, with primitives as paths', () => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 10, y: 20, width: 30, height: 40 },
      fill: RED,
    });
    const [b] = ok(target, {
      type: 'createEllipse',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: BLUE,
    });
    const value = scene(target);
    expect(value.rootOrder).toEqual([a, b]);
    const rect = node(value, a!);
    expect(rect.kind).toBe('path');
    expect(rect.transform).toEqual([1, 0, 0, 1, 10, 20]);
    expect(node(value, b!).kind).toBe('path');
    for (const each of value.nodes.values())
      expect(['container', 'path', 'text']).toContain(each.kind);
  });

  it('keeps page ids only, drops descendants of kept ids, hidden and unknown ids', () => {
    const target = editor();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 100, y: 100, width: 50, height: 50 },
      fill: RED,
    });
    const [child] = ok(target, {
      type: 'createRectangle',
      frame: { x: 110, y: 110, width: 10, height: 10 },
      fill: BLUE,
      parent: frame!,
    });
    const [hidden] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 5, height: 5 },
      fill: RED,
    });
    ok(target, { type: 'setNodeProps', id: hidden!, props: { visible: false } });
    const value = scene(target, [child!, frame!, hidden!, 'nope']);
    expect(value.rootOrder).toEqual([frame]);
    expect(target.query({ type: 'exportScene', ids: [hidden!] })).toBeNull();
    expect(target.query({ type: 'exportScene', ids: [] })).toBeNull();
    expect(target.query({ type: 'exportSvg', ids: ['nope'] })).toBeNull();
    expect(editor().query({ type: 'exportScene' })).toBeNull();
  });

  it('gives a nested root its page transform and no ancestor clip or opacity', () => {
    const target = editor();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 100, y: 50, width: 20, height: 20 },
      fill: RED,
    });
    ok(target, { type: 'setNodeProps', id: frame!, props: { opacity: 0.5 } });
    const [child] = ok(target, {
      type: 'createRectangle',
      frame: { x: 110, y: 60, width: 30, height: 5 },
      fill: BLUE,
      parent: frame!,
    });
    const value = scene(target, [child!]);
    expect(value.rootOrder).toEqual([child]);
    const root = node(value, child!);
    expect(root.transform).toEqual([1, 0, 0, 1, 110, 60]);
    expect(root.opacity).toBe(1);
    // Not clipped by the frame: the bounds reach past the frame's right edge (120).
    expect(value.bounds).toEqual({ x: 110, y: 60, width: 30, height: 5 });
  });

  it('keeps a hidden mask source as the mask', () => {
    const target = editor();
    const [source] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 20, 0, 10, 20],
      fill: RED,
    });
    const [content] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 40, height: 40 },
      fill: BLUE,
    });
    const [mask] = ok(target, { type: 'groupNodes', ids: [source!, content!], kind: 'maskGroup' });
    ok(target, { type: 'setNodeProps', id: source!, props: { visible: false } });
    const value = scene(target, [mask!]);
    const group = node(value, mask!);
    expect(group.kind === 'container' && group.clip).toEqual({ kind: 'mask' });
    expect(value.nodes.has(source!)).toBe(true);
  });
});

describe('V30-A02 bounds', () => {
  it('grows by a stroke and rounds outward', () => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 10.25, y: 10, width: 20, height: 20 },
      fill: RED,
      stroke: stroke(4, { join: 'round' }),
    });
    expect(scene(target, [a!]).bounds).toEqual({ x: 8, y: 8, width: 25, height: 24 });
  });

  it('covers a rotated node', () => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 20, height: 20 },
      fill: RED,
      rotation: Math.PI / 4,
    });
    const half = 10 * Math.SQRT2;
    const { bounds } = scene(target, [a!]);
    expect(bounds.x).toBe(Math.floor(10 - half));
    expect(bounds.x + bounds.width).toBe(Math.ceil(10 + half));
  });

  it('unions several roots', () => {
    const target = editor();
    ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: RED,
    });
    ok(target, {
      type: 'createRectangle',
      frame: { x: 50, y: 70, width: 10, height: 10 },
      fill: RED,
    });
    expect(scene(target).bounds).toEqual({ x: 0, y: 0, width: 60, height: 80 });
  });
});

describe('V30-A03 SVG', () => {
  it('writes a parseable document with the bounds as viewBox', () => {
    const target = editor();
    ok(target, {
      type: 'createRectangle',
      frame: { x: 5, y: 6, width: 10, height: 10 },
      fill: RED,
    });
    const svg = target.query({ type: 'exportSvg' })!;
    const root = parseSvg(svg)[0]!;
    expect(root.attributes.viewBox).toBe('5 6 10 10');
    expect(root.attributes.width).toBe('10');
    expect(svg).toContain('transform="matrix(1 0 0 1 5 6)"');
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('d="M0 0L10 0L10 10L0 10Z"');
  });

  it('writes opacity, strokes with dash, solid alpha and gradients with spread', () => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line'],
      points: [0, 0, 10, 0, 10, 10],
      fill: null,
      stroke: stroke(2, { cap: 'round', join: 'bevel', dash: { pattern: [3, 1], phase: 0.5 } }),
    });
    ok(target, { type: 'setNodeProps', id: a!, props: { opacity: 0.25 } });
    const [b] = ok(target, {
      type: 'createRectangle',
      frame: { x: 20, y: 0, width: 10, height: 10 },
      fill: {
        kind: 'linear',
        transform: [1, 0, 0, 1, 0, 0],
        stops: [
          { offset: 0, color: RED },
          { offset: 1, color: BLUE },
        ],
        spread: 'reflect',
      },
      stroke: stroke(1, { color: BLUE, join: 'round' }),
    });
    const svg = target.query({ type: 'exportSvg' })!;
    parseSvg(svg);
    expect(svg).toContain('opacity="0.25"');
    expect(svg).toContain(
      'stroke="#ff0000" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="4" stroke-dasharray="3 1" stroke-dashoffset="0.5"',
    );
    expect(svg).toContain('stroke="#0000ff" stroke-opacity="0.5"');
    expect(svg).toMatch(
      /<linearGradient id="g\d+" gradientUnits="userSpaceOnUse" gradientTransform="matrix\(10 0 0 10 0 0\)" spreadMethod="reflect" x1="0" y1="0" x2="1" y2="0">/,
    );
    expect(svg).toContain('<stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/>');
    expect(b).toBeDefined();
  });

  it('clips frames and masks', () => {
    const target = editor();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 50, height: 40 },
      fill: RED,
    });
    ok(target, {
      type: 'createRectangle',
      frame: { x: 30, y: 30, width: 40, height: 40 },
      fill: BLUE,
      parent: frame!,
    });
    const [source] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [100, 0, 140, 0, 120, 30],
      fillRule: 'evenodd',
      fill: RED,
    });
    const [content] = ok(target, {
      type: 'createRectangle',
      frame: { x: 100, y: 0, width: 40, height: 40 },
      fill: BLUE,
    });
    ok(target, { type: 'groupNodes', ids: [source!, content!], kind: 'maskGroup' });
    const svg = target.query({ type: 'exportSvg' })!;
    parseSvg(svg);
    expect(svg).toMatch(
      /<clipPath id="c\d+"><rect x="0" y="0" width="50" height="40"\/><\/clipPath>/,
    );
    expect(svg).toMatch(/<clipPath id="c\d+"><path[^>]* clip-rule="evenodd"\/><\/clipPath>/);
    // The mask source is never painted: one triangle path in the clip, none in the body.
    expect(svg.match(/L40 0L20 30Z/g)).toHaveLength(1);
  });

  it('writes text as tspans per cluster and escapes markup', () => {
    const target = editor(true);
    ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 100, height: 20 },
      runs: [{ text: 'a<&"b', family: 'Noto Sans KR', size: 16, color: RED }],
    });
    const svg = target.query({ type: 'exportSvg' })!;
    const elements = parseSvg(svg);
    const spans = elements.filter((element) => element.name === 'tspan');
    expect(spans).toHaveLength(5);
    expect(spans.map((span) => unescape(span.text)).join('')).toBe('a<&"b');
    const text = elements.find((element) => element.name === 'text')!;
    expect(text.attributes['font-family']).toContain('Noto Sans KR');
    expect(text.attributes['font-size']).toBe('16');
    expect(svg).toContain('xml:space="preserve"');
  });

  it('writes numbers with at most 4 decimals', () => {
    expect(svgNumber(1 / 3)).toBe('0.3333');
    expect(svgNumber(-0.00001)).toBe('0');
    expect(svgNumber(1e21)).toBe('1e+21');
  });
});

describe('V30-A05 export panel names (export-model)', () => {
  it('names files and buttons', async () => {
    const model = await import('../../packages/ui/src/export-model.js');
    expect(model.exportFileName('Card', 'png', 1)).toBe('Card.png');
    expect(model.exportFileName('Card', 'png', 2)).toBe('Card@2x.png');
    expect(model.exportFileName('Card', 'png', 0.5)).toBe('Card@0.5x.png');
    expect(model.exportFileName('Card', 'svg', 3)).toBe('Card.svg');
    expect(model.exportFileName('a/b:c?', 'svg', 1)).toBe('a_b_c_.svg');
    expect(model.exportFileName('  ', 'png', 1)).toBe('export.png');
    expect(model.exportFileName('..', 'png', 1)).toBe('export.png');
    expect(model.exportTargetName([], undefined, 'Page 1')).toBe('Page 1');
    expect(model.exportTargetName(['a'], 'Card', 'Page 1')).toBe('Card');
    expect(model.exportTargetName(['a', 'b'], undefined, 'Page 1')).toBe('export');
    expect(model.exportButtonLabel([], 'Page 1')).toBe('Export page Page 1');
    expect(model.exportButtonLabel(['a'], 'Card')).toBe('Export Card');
    expect(model.exportButtonLabel(['a', 'b'], 'export')).toBe('Export 2 layers');
  });
});

describe('V30-P1/P2 PNG helpers (react)', () => {
  it('sizes the image and refuses out-of-range exports', async () => {
    const image = await import('../../packages/react/src/export-image.js');
    const bounds = { x: 0, y: 0, width: 61, height: 10 };
    expect(image.exportPixelSize({ bounds }, 1)).toEqual({ width: 61, height: 10 });
    expect(image.exportPixelSize({ bounds }, 0.5)).toEqual({ width: 31, height: 5 });
    expect(image.exportPixelSize({ bounds }, 0)).toBeNull();
    expect(image.exportPixelSize({ bounds }, 17)).toBeNull();
    expect(image.exportPixelSize({ bounds: { ...bounds, width: 16_385 } }, 1)).toBeNull();
    expect(
      image.exportPixelSize({ bounds: { ...bounds, width: 16_000, height: 16_000 } }, 1),
    ).toBeNull();
  });

  it('repeats and reflects gradient stops over the extent', async () => {
    const image = await import('../../packages/react/src/export-image.js');
    const stops = [
      { offset: 0, color: RED },
      { offset: 1, color: BLUE },
    ];
    expect(image.spreadStops({ stops, spread: 'pad' }, 0, 1).map((s) => s.offset)).toEqual([0, 1]);
    const repeat = image.spreadStops({ stops, spread: 'repeat' }, 0, 2);
    expect(repeat.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(repeat[2]!.color).toBe('rgba(255, 0, 0, 1)');
    const reflect = image.spreadStops({ stops, spread: 'reflect' }, -1, 1);
    expect(reflect.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
    // The mirrored cycle [-1, 0] runs blue to red.
    expect(reflect[0]!.color).toBe('rgba(0, 0, 255, 0.5)');
  });
});
