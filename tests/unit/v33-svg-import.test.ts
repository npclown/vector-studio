import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  isSvgText,
  svgToFragment,
  type Command,
  type Editor,
  type ExportScene,
  type Gradient,
  type SvgImportOptions,
  type SvgTextRun,
} from '../../packages/editor-core/src/index.js';
import { parsePathData, arcToCubics } from '../../packages/editor-core/src/svg-path-data.js';
import { parseColor, parseTransform } from '../../packages/editor-core/src/svg-style.js';
import { CanvasInput } from '../../packages/react/src/canvas-input.js';
import {
  importSvgFiles,
  type SvgFileImport,
  type SvgFileLike,
} from '../../packages/react/src/import-svg.js';
import { importMessages } from '../../packages/ui/src/import-model.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// V-33 SVG import contract (docs/plans/viz-v33-svg-import-contract.md): V33-A01 to A05.

type FragmentNode = Record<string, unknown> & {
  id: string;
  type: string;
  name: string;
  parent: string;
  frame: { x: number; y: number; width: number; height: number };
  rotation: number;
  opacity: number;
  children?: string[];
  fill?: unknown;
  stroke?: unknown;
  path?: { verbs: string[]; points: number[]; fillRule: string };
};
type Fragment = { roots: string[]; nodes: Record<string, FragmentNode> };

/** Measures 5 units per UTF-16 unit of the longest line, 12 per line, baseline 9. */
const layout = (runs: readonly SvgTextRun[]) => {
  const lines = runs
    .map((run) => run.text)
    .join('')
    .split('\n');
  return {
    width: 5 * Math.max(...lines.map((line) => line.length)),
    height: 12 * lines.length,
    baseline: 9,
  };
};

const svg = (body: string, attributes = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;

function convert(text: string, options: SvgImportOptions = {}) {
  const result = svgToFragment(text, { layout, ...options });
  if (!('fragment' in result)) throw new Error(`failed: ${result.code}`);
  const body = JSON.parse(result.fragment.slice(result.fragment.indexOf('\n') + 1)) as Fragment;
  return { ...result, body };
}

/** The fragment's nodes in pre-order from the roots. */
function nodes(text: string, options: SvgImportOptions = {}): FragmentNode[] {
  const { body } = convert(text, options);
  const out: FragmentNode[] = [];
  const visit = (id: string) => {
    const node = body.nodes[id]!;
    out.push(node);
    node.children?.forEach(visit);
  };
  body.roots.forEach(visit);
  return out;
}

const only = (text: string) => {
  const list = nodes(text);
  expect(list).toHaveLength(1);
  return list[0]!;
};

/** A path node's points in page space (its frame is page space when it is a root). */
function pagePoints(node: FragmentNode): number[] {
  const { x, y, width, height } = node.frame;
  return node.path!.points.map((value, index) =>
    index % 2 === 0 ? x + value * width : y + value * height,
  );
}

function close(actual: readonly number[], expected: readonly number[], digits = 6) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, digits));
}

describe('V33-A01 XML subset and failures', () => {
  it('detects SVG text by its first element', () => {
    expect(isSvgText('<svg/>')).toBe(true);
    expect(
      isSvgText(
        '﻿<?xml version="1.0"?>\n<!-- c --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg width="1">',
      ),
    ).toBe(true);
    expect(isSvgText('  <svg:svg xmlns:svg="http://www.w3.org/2000/svg">')).toBe(true);
    expect(isSvgText('<svgx/>')).toBe(false);
    expect(isSvgText('hello <svg/>')).toBe(false);
    expect(isSvgText('<html><svg/></html>')).toBe(false);
    expect(isSvgText('vector-studio/fragment\n{}')).toBe(false);
  });

  it('reads entities, CDATA, comments and processing instructions', () => {
    const list = nodes(
      svg(
        '<!-- c --><?pi x?><title>A &amp; B &#x41;&#66;</title><rect width="1" height="1"/><![CDATA[ x ]]><rect x="2" width="1" height="1"/>',
      ),
    );
    expect(list[0]!.name).toBe('A & B AB');
  });

  it('fails malformed text, the wrong root, an entity DOCTYPE and the limits', () => {
    const code = (text: string) => {
      const result = svgToFragment(text);
      return result.ok ? 'ok' : result.code;
    };
    expect(code('<svg><rect></svg>')).toBe('editor.invalid-svg');
    expect(code('<svg a="1" a="2"/>')).toBe('editor.invalid-svg');
    expect(code('<svg>&nbsp;</svg>')).toBe('editor.invalid-svg');
    expect(code('<svg>a & b</svg>')).toBe('editor.invalid-svg');
    expect(code('<html/>')).toBe('editor.invalid-svg');
    expect(code('<!DOCTYPE svg [<!ENTITY % x "y">]><svg/>')).toBe('editor.invalid-svg');
    expect(code('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>')).toBe(
      'editor.invalid-svg',
    );
    expect(code('<!DOCTYPE svg [<!ENTITY a "x"><!ENTITY b "&a;&a;">]><svg/>')).toBe(
      'editor.invalid-svg',
    );
    expect(code('<!DOCTYPE svg [<!ELEMENT svg ANY>]><svg/>')).toBe('editor.invalid-svg');
    expect(code('<svg/><svg/>')).toBe('editor.invalid-svg');
    expect(code(`<svg>${'<g>'.repeat(300)}${'</g>'.repeat(300)}</svg>`)).toBe('editor.invalid-svg');
    expect(code(`<svg>${'<g/>'.repeat(20_001)}</svg>`)).toBe('editor.invalid-svg');
    expect(code(`<svg>${' '.repeat(8 * 1024 * 1024)}</svg>`)).toBe('editor.invalid-svg');
    expect(code('<svg/>')).toBe('editor.empty-svg');
    expect(
      code(svg('<rect width="0" height="5"/><g display="none"><rect width="5" height="5"/></g>')),
    ).toBe('editor.empty-svg');
  });

  it('reads an Illustrator-style DOCTYPE with internal entities', () => {
    const text =
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
      '<!ENTITY ns_svg "http://www.w3.org/2000/svg"><!ENTITY st0 "fill:#ff0000;"><!-- c -->]>' +
      '<svg xmlns="&ns_svg;"><rect style="&st0;" width="2" height="2"/></svg>';
    expect(isSvgText(text)).toBe(true);
    expect(only(text).fill).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  it('stops <use> fan-out over leaves that draw nothing', () => {
    let body = '<defs><g id="a0"><rect width="0" height="0"/></g>';
    for (let i = 1; i <= 8; i += 1)
      body += `<g id="a${i}">${`<use href="#a${i - 1}"/>`.repeat(10)}</g>`;
    body += '</defs><use href="#a8"/><rect width="1" height="1"/>';
    const started = Date.now();
    const result = svgToFragment(svg(body));
    expect(result.ok ? 'ok' : result.code).toBe('editor.invalid-svg');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops <use> expansion past 10,000 nodes', () => {
    let body = '<defs><rect id="u0" width="1" height="1"/>';
    for (let i = 1; i <= 6; i += 1) {
      body += `<g id="u${i}">${`<use href="#u${i - 1}"/>`.repeat(10)}</g>`;
    }
    body += '</defs><use href="#u6"/>';
    const result = svgToFragment(svg(body));
    expect(result.ok ? 'ok' : result.code).toBe('editor.invalid-svg');
  });
});

describe('V33-A02 path grammar', () => {
  it('reads absolute, relative and implicit commands and number runs', () => {
    const out = parsePathData('M1 2l3,4H10v-2h-1V0zm1-1 1.5.5 2e1 0');
    expect(out.verbs).toEqual([
      'move',
      'line',
      'line',
      'line',
      'line',
      'line',
      'close',
      'move',
      'line',
      'line',
    ]);
    expect(out.points).toEqual([1, 2, 4, 6, 10, 6, 10, 4, 9, 4, 9, 0, 2, 1, 3.5, 1.5, 23.5, 1.5]);
  });

  it('elevates quadratics and reflects S and T controls', () => {
    const out = parsePathData('M0 0Q3 3 6 0T12 0');
    expect(out.verbs).toEqual(['move', 'cubic', 'cubic']);
    close(out.points, [0, 0, 2, 2, 4, 2, 6, 0, 8, -2, 10, -2, 12, 0]);
    const s = parsePathData('M0 0C1 1 2 1 3 0S5 -1 6 0s1 1 2 0');
    close(s.points, [0, 0, 1, 1, 2, 1, 3, 0, 4, -1, 5, -1, 6, 0, 7, 1, 7, 1, 8, 0]);
  });

  it('turns arcs into cubics on the ellipse, with flags and radius scale-up', () => {
    const half = arcToCubics(0, 0, 5, 5, 0, false, true, 10, 0);
    expect(half).toHaveLength(2);
    expect(half[0]![4]).toBeCloseTo(5);
    expect(half[0]![5]).toBeCloseTo(-5); // sweep 1 goes through the top (y up is negative)
    const small = arcToCubics(0, 0, 1, 1, 0, false, true, 10, 0);
    expect(small[0]![5]).toBeCloseTo(-5); // radius scaled up to 5
    const large = arcToCubics(0, 0, 10, 10, 0, true, false, 10, 0);
    expect(large.length).toBeGreaterThanOrEqual(3);
    expect(arcToCubics(0, 0, 0, 5, 0, false, true, 3, 4)).toEqual([[3, 4]]);
    expect(arcToCubics(1, 1, 5, 5, 0, false, true, 1, 1)).toEqual([]);
    const flags = parsePathData('M0 0a5 5 0 0110 0');
    expect(flags.verbs).toEqual(['move', 'cubic', 'cubic']);
    close(flags.points.slice(-2), [10, 0]);
  });

  it('keeps the segments before an error and draws nothing without a leading move', () => {
    expect(parsePathData('M0 0L1 1L2').verbs).toEqual(['move', 'line']);
    expect(parsePathData('L1 1').verbs).toEqual([]);
    expect(parsePathData('M0 0Z L5 5').verbs).toEqual(['move', 'close', 'move', 'line']);
  });
});

describe('V33-A03 mapping', () => {
  it('maps the viewBox with preserveAspectRatio and units', () => {
    const rect = only(
      svg(
        '<rect x="2" y="2" width="10" height="10"/>',
        'width="48" height="24" viewBox="0 0 24 24"',
      ),
    );
    // meet: scale 1, centred horizontally (48 − 24) / 2 = 12.
    expect(rect.frame).toEqual({ x: 14, y: 2, width: 10, height: 10 });
    const none = only(
      svg(
        '<rect width="10" height="10"/>',
        'width="48" height="24" viewBox="0 0 24 24" preserveAspectRatio="none"',
      ),
    );
    expect(none.frame).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    const mm = only(
      svg('<rect width="24" height="24"/>', 'width="24mm" height="24mm" viewBox="0 0 24 24"'),
    );
    expect(mm.frame.width).toBeCloseTo((24 * 96) / 25.4);
  });

  it('keeps rectangles and ellipses under translate, scale and rotate, else bakes a path', () => {
    const r = only(
      svg('<rect x="1" y="2" width="10" height="4" rx="1" transform="translate(5 5) scale(2)"/>'),
    );
    expect(r.type).toBe('rectangle');
    expect(r.frame).toEqual({ x: 7, y: 9, width: 20, height: 8 });
    expect(r.cornerRadii).toEqual([2, 2, 2, 2]);
    const rotated = only(
      svg('<ellipse cx="10" cy="10" rx="10" ry="5" transform="rotate(90 10 10)"/>'),
    );
    expect(rotated.type).toBe('ellipse');
    expect(rotated.rotation).toBeCloseTo(Math.PI / 2);
    expect(rotated.frame.x).toBeCloseTo(0);
    expect(rotated.frame.width).toBeCloseTo(20);
    const elliptic = only(svg('<rect width="10" height="10" rx="2" transform="scale(2 1)"/>'));
    expect(elliptic.type).toBe('path');
    const skew = only(svg('<circle r="5" transform="skewX(30)"/>'));
    expect(skew.type).toBe('path');
    const line = only(svg('<line x1="0" y1="5" x2="10" y2="5" stroke="red" stroke-width="2"/>'));
    expect(line.type).toBe('path');
    expect(line.frame).toEqual({ x: 0, y: 5, width: 10, height: 0 });
    expect(line.fill).toBeNull();
    const poly = only(svg('<polygon points="0,0 10,0 10-10"/>'));
    expect(poly.path!.verbs).toEqual(['move', 'line', 'line', 'close']);
    close(pagePoints(poly), [0, 0, 10, 0, 10, -10]);
  });

  it('parses transforms and colours', () => {
    close([...parseTransform('translate(10) rotate(90)')], [0, 1, -1, 0, 10, 0]);
    expect(parseTransform('scale(2) bogus(1)')).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseColor('#f00')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('#ff000080')!.a).toBeCloseTo(128 / 255);
    expect(parseColor('rgb(255 0 0 / 50%)')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgba(0, 0, 255, .25)')).toEqual({ r: 0, g: 0, b: 1, a: 0.25 });
    const hsl = parseColor('hsl(120, 100%, 50%)')!;
    close([hsl.r, hsl.g, hsl.b], [0, 1, 0]);
    expect(parseColor('RebeccaPurple')).toEqual(parseColor('#663399'));
    expect(parseColor('nope')).toBeNull();
  });

  it('cascades style attribute, sheet rules, attributes and inheritance', () => {
    const list = nodes(
      svg(
        '<style>rect{fill:blue} .a{fill:#0f0} #x{fill:#00f} @media print{rect{fill:red}} rect > g{fill:red}</style>' +
          '<g fill="red" stroke="#000" stroke-width="3" opacity="0.5">' +
          '<rect width="1" height="1"/><rect class="a" x="2" width="1" height="1"/>' +
          '<rect id="x" class="a" x="4" width="1" height="1" style="fill: yellow !important"/>' +
          '<path d="M0 0L1 1" fill="inherit" stroke="none"/></g>',
      ),
    );
    const [group, a, b, c, d] = list;
    expect(group!.type).toBe('group');
    expect(group!.opacity).toBe(0.5);
    expect(a!.fill).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(b!.fill).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(c!.fill).toEqual({ r: 1, g: 1, b: 0, a: 1 });
    expect((a!.stroke as { width: number }).width).toBe(3);
    expect(d!.fill).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(d!.stroke).toBeNull();
    expect(
      convert(svg('<style>a b{fill:red}</style><rect width="1" height="1"/>')).skipped,
    ).toEqual(['css-selector']);
  });

  it('converts strokes: width scale, dash rules, miter limit, opacity', () => {
    const node = only(
      svg(
        '<path d="M0 0L10 0L10 10" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="2" stroke-dasharray="1 2 3" stroke-dashoffset="1" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="0.5" transform="scale(3)"/>',
      ),
    );
    expect(node.stroke).toEqual({
      color: { r: 0, g: 0, b: 0, a: 0.5 },
      width: 6,
      cap: 'round',
      join: 'bevel',
      miterLimit: 4,
      dash: { pattern: [3, 6, 9, 3, 6, 9], phase: 3 },
    });
    const noDash = (value: string) =>
      (
        only(svg(`<path d="M0 0L5 0" stroke="red" stroke-dasharray="${value}"/>`)).stroke as {
          dash: unknown;
        }
      ).dash;
    expect(noDash('0 0')).toBeNull();
    expect(noDash('1 -1')).toBeNull();
    expect(noDash(Array(17).fill(1).join(' '))).toBeNull();
  });

  it('converts gradients: units, transform, href, stop clamping and picking, fallbacks', () => {
    const rect = only(
      svg(
        '<defs><linearGradient id="base" x1="0" y1="0" x2="1" y2="0" spreadMethod="reflect"><stop offset="0.5" stop-color="red"/><stop offset="20%" style="stop-color:blue;stop-opacity:.5"/></linearGradient>' +
          '<linearGradient id="g" href="#base" gradientTransform="rotate(90)"/></defs>' +
          '<rect width="10" height="20" fill="url(#g)" fill-opacity="0.5"/>',
      ),
    );
    const fill = rect.fill as Gradient;
    expect(fill.kind).toBe('linear');
    expect(fill.spread).toBe('reflect');
    expect(fill.stops).toEqual([
      { offset: 0.5, color: { r: 1, g: 0, b: 0, a: 0.5 } },
      { offset: 0.5, color: { r: 0, g: 0, b: 1, a: 0.25 } },
    ]);
    // objectBoundingBox: rotate(90) maps (1,0) to (0,1) in the box, which is the unit box.
    close([...fill.transform], [0, 1, -1, 0, 0, 0]);
    const user = only(
      svg(
        '<radialGradient id="r" gradientUnits="userSpaceOnUse" cx="10" cy="10" r="5" fx="1"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient><rect width="20" height="20" fill="url(#r)"/>',
      ),
    );
    close([...(user.fill as Gradient).transform], [0.25, 0, 0, 0.25, 0.5, 0.5]);
    expect(
      convert(
        svg(
          '<radialGradient id="r" fx="1"><stop/><stop offset="1"/></radialGradient><rect width="1" height="1" fill="url(#r)"/>',
        ),
      ).skipped,
    ).toEqual(['focal-point']);
    const many = Array.from(
      { length: 20 },
      (_, i) => `<stop offset="${i / 19}" stop-color="#${i < 10 ? '0' : ''}${i}0000"/>`,
    ).join('');
    const picked = only(
      svg(
        `<linearGradient id="m">${many}</linearGradient><rect width="1" height="1" fill="url(#m)"/>`,
      ),
    ).fill as Gradient;
    expect(picked.stops).toHaveLength(16);
    expect(picked.stops[0]!.offset).toBe(0);
    expect(picked.stops[15]!.offset).toBe(1);
    const one = only(
      svg(
        '<linearGradient id="o"><stop stop-color="lime"/></linearGradient><rect width="1" height="1" fill="url(#o)"/>',
      ),
    );
    expect(one.fill).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    const flat = only(
      svg(
        '<linearGradient id="f"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><line x2="10" stroke="url(#f)"/>',
      ),
    );
    expect((flat.stroke as { color: unknown }).color).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    const missing = only(svg('<rect width="1" height="1" fill="url(#none) green"/>'));
    expect(missing.fill).toEqual({ r: 0, g: 128 / 255, b: 0, a: 1 });
    expect(
      convert(svg('<pattern id="p"/><rect width="1" height="1" fill="url(#p)" stroke="red"/>'))
        .skipped,
    ).toEqual(['pattern']);
  });

  it('turns clip-path into a mask group in the element user space', () => {
    const list = nodes(
      svg(
        '<clipPath id="c"><rect width="5" height="5"/></clipPath>' +
          '<g transform="translate(100 0)" clip-path="url(#c)"><rect width="10" height="10"/></g>',
      ),
    );
    expect(list.map((node) => node.type)).toEqual(['maskGroup', 'path', 'rectangle']);
    const mask = list[1]!;
    expect(mask.frame).toEqual({ x: 0, y: 0, width: 5, height: 5 });
    expect(list[0]!.frame).toEqual({ x: 100, y: 0, width: 10, height: 10 });
    const box = nodes(
      svg(
        '<clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath><rect width="10" height="20" clip-path="url(#c)"/>',
      ),
    );
    expect(box[1]!.frame).toEqual({ x: 0, y: 0, width: 5, height: 20 });
    expect(
      svgToFragment(svg('<clipPath id="e"/><rect width="1" height="1" clip-path="url(#e)"/>')),
    ).toEqual({ ok: false, code: 'editor.empty-svg' });
  });

  it('converts text: runs, lines, anchor, baseline, families and skipped styles', () => {
    const result = convert(
      svg(
        '<text x="100" y="50" font-family="\'My Font\', serif" font-size="2em" text-anchor="middle" font-weight="bold">  Hi\n  <tspan fill="red">there</tspan><tspan x="100" y="80">next</tspan></text>',
      ),
    );
    const text = Object.values(result.body.nodes)[0]!;
    expect(text.type).toBe('text');
    expect(text.runs).toEqual([
      { text: 'Hi ', family: 'My Font', size: 32, color: { r: 0, g: 0, b: 0, a: 1 } },
      { text: 'there', family: 'My Font', size: 32, color: { r: 1, g: 0, b: 0, a: 1 } },
      { text: '\nnext', family: 'My Font', size: 32, color: { r: 0, g: 0, b: 0, a: 1 } },
    ]);
    // width 5 × 8 ("Hi there"), anchor middle: x = 100 − 20; y = 50 − baseline 9.
    expect(text.frame).toEqual({ x: 80, y: 41, width: 40, height: 24 });
    expect(text.align).toBe('center');
    expect(result.skipped).toEqual(['font-weight']);
    expect(result.hasText).toBe(true);
    const generic = only(svg('<text font-family="sans-serif">a</text>'));
    expect((generic.runs as { family: string }[])[0]!.family).toBe('Arial');
    const preserve = only(
      svg(
        '<g xml:space="preserve"><text><tspan x="1" y="2">a</tspan><tspan x="4" y="2"> </tspan><tspan x="6" y="2">b</tspan></text></g>',
      ),
    );
    expect((preserve.runs as { text: string }[])[0]!.text).toBe('a b');
    expect(preserve.frame.x).toBe(1);
  });

  it('expands <use> and <symbol>, cuts cycles, skips unsupported elements', () => {
    const list = nodes(
      svg(
        '<defs><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol><g id="loop"><use href="#loop"/><rect width="1" height="1"/></g></defs>' +
          '<use xlink:href="#s" x="5" y="5" width="20" height="20"/><use href="#loop"/><image/><filter id="f"/><rect width="1" height="1" filter="url(#f)"/>',
      ),
    );
    const symbolRect = list.find((node) => node.type === 'rectangle' && node.frame.width === 20);
    expect(symbolRect).toBeDefined();
    expect(
      convert(
        svg(
          '<image/><foreignObject/><rect width="1" height="1" filter="url(#f)" mask="url(#m)" marker-end="url(#a)"/>',
        ),
      ).skipped,
    ).toEqual(['image', 'foreignObject', 'mask', 'filter', 'marker']);
  });

  it('handles the review r1 cases: zero sizes, gradient text, use opacity, big paths, units', () => {
    const zero = only(svg('<text>A<tspan font-size="0">HIDDEN</tspan></text>'));
    expect((zero.runs as { text: string }[]).map((run) => run.text).join('')).toBe('A');
    const gradient = only(
      svg(
        '<linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><text fill="url(#g)">a</text>',
      ),
    );
    expect((gradient.runs as { color: unknown }[])[0]!.color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    const used = nodes(
      svg('<symbol id="s"><rect width="5" height="5"/></symbol><use href="#s" opacity="0.5"/>'),
    );
    expect(used[0]!.opacity).toBe(0.5);
    const big = Array.from({ length: 40_000 }, (_, i) => `L${i % 100} ${Math.floor(i / 100)}`).join(
      '',
    );
    expect(only(svg(`<path d="M0 0${big}"/>`)).type).toBe('path');
    expect(svgToFragment(svg('<path d="M5 5"/><path d="M0 0L10 0"/>'))).toEqual({
      ok: false,
      code: 'editor.empty-svg',
    });
    expect(only(svg('<path d="M0 0L10 0" stroke="red"/>')).frame.height).toBe(0);
    const percent = only(svg('<text x="50%" y="10mm">a</text>', 'width="200" height="100"'));
    expect(percent.frame.x).toBe(100);
    expect(percent.frame.y).toBeCloseTo((10 * 96) / 25.4 - 9);
    expect(
      nodes(
        svg('<rect width="2" height="2"/><rect x="4" width="2" height="2"/>', 'opacity="0.5"'),
      )[0]!.opacity,
    ).toBe(0.5);
    expect(convert(svg('<text font-weight="normal">a</text>')).skipped).toEqual([]);
    expect(
      convert(svg('<style>.b{font-weight:bold}</style><text>a<tspan class="b">b</tspan></text>'))
        .skipped,
    ).toEqual(['font-weight']);
    expect(
      convert(svg('<rect width="1" height="1"><animate attributeName="x"/></rect>')).skipped,
    ).toEqual(['animate']);
  });

  it('fails references that multiply the output past the point budget (V33-C2)', () => {
    // One clip of many shapes referenced by many elements.
    const clipRects = Array.from(
      { length: 1000 },
      (_, i) => `<rect x="${i}" width="1" height="1"/>`,
    );
    const users = Array.from(
      { length: 300 },
      (_, i) => `<rect x="${i}" width="5" height="5" clip-path="url(#c)"/>`,
    );
    expect(
      svgToFragment(svg(`<clipPath id="c">${clipRects.join('')}</clipPath>${users.join('')}`)),
    ).toEqual({ ok: false, code: 'editor.invalid-svg' });
    // A heavy path copied through nested <use>.
    const d = `M0 0 ${Array.from({ length: 30_000 }, (_, i) => `L${i % 97} ${i % 89}`).join(' ')} Z`;
    const ten = (href: string, id: string) =>
      `<g id="${id}">${Array.from({ length: 10 }, () => `<use href="#${href}"/>`).join('')}</g>`;
    const heavy = svg(
      `<defs><path id="p" d="${d}"/>${ten('p', 'a')}${ten('a', 'b')}</defs>${ten('b', 'c')}`,
    );
    expect(svgToFragment(heavy)).toEqual({ ok: false, code: 'editor.invalid-svg' });
    // The same path drawn a few times imports.
    expect(svgToFragment(svg(`<path d="${d}"/><use href="#x"/>`)).ok).toBe(true);
  });

  it('detects SVG past a quoted ] in an entity value and reports inherited font weight', () => {
    expect(isSvgText('<!DOCTYPE svg [<!ENTITY a "x]y">]><svg>')).toBe(true);
    expect(convert(svg('<g font-weight="bold"><text>a</text></g>')).skipped).toEqual([
      'font-weight',
    ]);
    expect(
      convert(svg('<g font-weight="bold"><text font-weight="inherit">a</text></g>')).skipped,
    ).toEqual(['font-weight']);
  });

  it('names the wrapping group by title, then options.name, then SVG', () => {
    const two = '<rect width="1" height="1"/><rect x="3" width="1" height="1"/>';
    expect(nodes(svg(`<title>Logo</title>${two}`))[0]!.name).toBe('Logo');
    expect(nodes(svg(two), { name: 'icon.svg' })[0]!.name).toBe('icon.svg');
    expect(nodes(svg(two))[0]!.name).toBe('SVG');
    expect(nodes(svg('<rect id="box" width="1" height="1"/>'))[0]!.name).toBe('box');
  });
});

function editor(withText = true): Editor {
  const target = createEditor({
    ids: createCounterIdSource('n'),
    ...(withText ? { textLayout: createFakeTextLayout() } : {}),
  });
  target.execute({ type: 'setViewportSize', width: 600, height: 400 });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

describe('V33-A05 paste rule', () => {
  const icon = svg('<rect width="10" height="10" fill="red"/><circle cx="20" cy="5" r="5"/>');

  it('imports SVG text centred on pointer, else at, else the viewport, as one selected step', () => {
    const target = editor();
    const ids = ok(target, {
      type: 'paste',
      text: icon,
      pointer: { x: 100, y: 100 },
      at: { x: 0, y: 0 },
    });
    expect(ids).toHaveLength(1);
    expect(target.query({ type: 'selection' })).toEqual(ids);
    const group = target.query({ type: 'node', id: ids[0]! })!;
    expect(group.type).toBe('group');
    expect(group.frame).toEqual({ x: 87.5, y: 95, width: 25, height: 10 });
    expect(target.getSnapshot().history.undoDepth).toBe(1);
    ok(target, { type: 'undo' });
    expect(target.query({ type: 'node', id: ids[0]! })).toBeNull();
    const second = ok(target, { type: 'paste', text: icon, at: { x: 0, y: 0 } });
    expect(target.query({ type: 'node', id: second[0]! })!.frame.x).toBe(-12.5);
    const third = ok(target, { type: 'paste', text: icon });
    expect(target.query({ type: 'node', id: third[0]! })!.frame.x).toBe(300 - 12.5);
  });

  it('fails with the converter codes, no viewport and no layout port', () => {
    const target = editor();
    expect(target.execute({ type: 'paste', text: '<svg><g></svg>' })).toEqual({
      ok: false,
      code: 'editor.invalid-svg',
    });
    expect(target.execute({ type: 'paste', text: '<svg/>' })).toEqual({
      ok: false,
      code: 'editor.empty-svg',
    });
    const noView = createEditor({ ids: createCounterIdSource('n') });
    expect(noView.execute({ type: 'paste', text: icon })).toEqual({
      ok: false,
      code: 'editor.no-viewport-size',
    });
    const noPort = editor(false);
    expect(noPort.execute({ type: 'paste', text: svg('<text>a</text>') })).toEqual({
      ok: false,
      code: 'editor.no-text-layout',
    });
    expect(noPort.execute({ type: 'paste', text: icon }).ok).toBe(true);
  });

  it('pastes SVG text as plain text in text edit mode', () => {
    const target = editor();
    const [id] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      runs: [{ text: 'x', family: 'Test', size: 10, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    ok(target, { type: 'enterTextEdit', id: id!, anchor: 1, focus: 1 });
    ok(target, { type: 'paste', text: '<svg/>' });
    const node = target.query({ type: 'node', id: id! })!;
    expect(node.type === 'text' && node.runs.map((run) => run.text).join('')).toBe('x<svg/>');
  });
});

// V33-A04: the round trip. Each drawn path in page space (points, paints, stroke), each clip
// region's page outline, each text run, compared up to one translation.
type Flat = { kind: string; points: number[]; data: unknown };

function flatten(scene: ExportScene): Flat[] {
  const out: Flat[] = [];
  const mul = (m: readonly number[], n: readonly number[]) => [
    m[0]! * n[0]! + m[2]! * n[1]!,
    m[1]! * n[0]! + m[3]! * n[1]!,
    m[0]! * n[2]! + m[2]! * n[3]!,
    m[1]! * n[2]! + m[3]! * n[3]!,
    m[0]! * n[4]! + m[2]! * n[5]! + m[4]!,
    m[1]! * n[4]! + m[3]! * n[5]! + m[5]!,
  ];
  const map = (m: readonly number[], points: readonly number[]) =>
    points.flatMap((_, i) =>
      i % 2 === 0
        ? [
            m[0]! * points[i]! + m[2]! * points[i + 1]! + m[4]!,
            m[1]! * points[i]! + m[3]! * points[i + 1]! + m[5]!,
          ]
        : [],
    );
  const paint = (m: readonly number[], value: unknown) =>
    value !== null && typeof value === 'object' && 'kind' in value
      ? { ...(value as Gradient), transform: mul(m, (value as Gradient).transform) }
      : value;
  const visit = (id: string, parent: readonly number[]) => {
    const node = scene.nodes.get(id)!;
    const m = mul(parent, node.transform);
    if (node.kind === 'container') {
      let children = node.children;
      if (node.clip?.kind === 'rect') {
        const { x, y, width, height } = node.clip;
        out.push({
          kind: 'clip',
          points: map(m, [x, y, x + width, y, x + width, y + height, x, y + height]),
          data: null,
        });
      } else if (node.clip?.kind === 'mask') {
        const source = scene.nodes.get(children[0]!)!;
        if (source.kind === 'path') {
          const sm = mul(m, source.transform);
          const points = map(sm, source.geometry.points);
          out.push({ kind: 'clip', points: points.slice(0, 8), data: null });
        }
        children = children.slice(1);
      }
      children.forEach((child) => visit(child, m));
    } else if (node.kind === 'path') {
      out.push({
        kind: 'path',
        points: map(m, node.geometry.points),
        data: {
          verbs: node.geometry.verbs,
          fill: paint(m, node.fill),
          stroke:
            node.stroke === null ? null : { ...node.stroke, color: paint(m, node.stroke.color) },
          opacity: node.opacity,
        },
      });
    } else {
      for (const run of node.runs) {
        out.push({
          kind: 'text',
          points: map(m, [run.clusters[0]!.x, run.clusters[0]!.y]),
          data: {
            size: run.size,
            color: run.color,
            text: run.clusters.map((c) => c.text).join(''),
          },
        });
      }
    }
  };
  scene.rootOrder.forEach((id) => visit(id, [1, 0, 0, 1, 0, 0]));
  return out;
}

function compareFlat(a: Flat[], b: Flat[]) {
  expect(b.map((entry) => entry.kind)).toEqual(a.map((entry) => entry.kind));
  const dx = b[0]!.points[0]! - a[0]!.points[0]!;
  const dy = b[0]!.points[1]! - a[0]!.points[1]!;
  const near = (x: unknown, y: unknown, path: string): void => {
    if (typeof x === 'number' && typeof y === 'number') {
      expect(Math.abs(x - y), `${path}: ${x} vs ${y}`).toBeLessThan(1e-2);
    } else if (Array.isArray(x) && Array.isArray(y)) {
      expect(y.length, path).toBe(x.length);
      x.forEach((value, i) => near(value, y[i], `${path}/${i}`));
    } else if (x !== null && typeof x === 'object' && y !== null && typeof y === 'object') {
      expect(Object.keys(y).sort(), path).toEqual(Object.keys(x).sort());
      for (const key of Object.keys(x))
        near(
          (x as Record<string, unknown>)[key],
          (y as Record<string, unknown>)[key],
          `${path}/${key}`,
        );
    } else expect(y, path).toEqual(x);
  };
  a.forEach((entry, index) => {
    const other = b[index]!;
    // V-30 writes at most 4 decimals, so a rotation's coefficients carry up to 5e-5 each.
    const tolerance = entry.kind === 'text' ? 0.5 : 1e-2;
    other.points.forEach((value, i) => {
      const expected = entry.points[i]! + (i % 2 === 0 ? dx : dy);
      expect(Math.abs(value - expected), `${entry.kind} ${index} point ${i}`).toBeLessThan(
        tolerance,
      );
    });
    expect(other.points.length).toBe(entry.points.length);
    // Gradient transforms carry the translation too: compare their linear part and shifted offset.
    const shift = (value: unknown): unknown => {
      if (value !== null && typeof value === 'object' && 'transform' in value && 'stops' in value) {
        const t = (value as Gradient).transform;
        return { ...(value as object), transform: [t[0], t[1], t[2], t[3], t[4] + dx, t[5] + dy] };
      }
      return value;
    };
    const data = entry.data as Record<string, unknown> | null;
    const shifted =
      data === null || entry.kind !== 'path'
        ? data
        : {
            ...data,
            fill: shift(data.fill),
            stroke:
              data.stroke === null
                ? null
                : {
                    ...(data.stroke as object),
                    color: shift((data.stroke as { color: unknown }).color),
                  },
          };
    near(shifted, other.data, `${entry.kind} ${index}`);
  });
}

describe('V33-A04 round trip with V-30 export', () => {
  it('exports, imports and exports the same page-space content', () => {
    const target = editor();
    const red = { r: 1, g: 0, b: 0, a: 1 };
    const grad = (kind: 'linear' | 'radial'): Gradient => ({
      kind,
      transform: [1, 0, 0, 1, 0, 0],
      stops: [
        { offset: 0, color: red },
        { offset: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
      ],
      spread: kind === 'linear' ? 'pad' : 'reflect',
    });
    ok(target, {
      type: 'createRectangle',
      frame: { x: 10, y: 10, width: 40, height: 30 },
      fill: grad('linear'),
    });
    ok(target, {
      type: 'createEllipse',
      frame: { x: 60, y: 10, width: 40, height: 20 },
      rotation: 0.4,
      fill: grad('radial'),
    });
    ok(target, {
      type: 'createPath',
      verbs: ['move', 'cubic', 'line'],
      points: [10, 60, 30, 40, 50, 80, 70, 60, 90, 70],
      fill: null,
      stroke: {
        color: red,
        width: 4,
        cap: 'round',
        join: 'round',
        miterLimit: 4,
        dash: { pattern: [5, 3], phase: 1 },
      },
    });
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 120, y: 10, width: 50, height: 50 },
      fill: { r: 0, g: 1, b: 0, a: 1 },
    });
    ok(target, {
      type: 'createRectangle',
      frame: { x: 150, y: 40, width: 40, height: 40 },
      fill: red,
      parent: frame!,
    });
    const [source] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [200, 10, 240, 10, 220, 50],
      fill: red,
    });
    const [content] = ok(target, {
      type: 'createRectangle',
      frame: { x: 200, y: 20, width: 40, height: 40 },
      fill: red,
    });
    ok(target, { type: 'groupNodes', ids: [source!, content!], kind: 'maskGroup' });
    ok(target, {
      type: 'createText',
      frame: { x: 10, y: 100, width: 1, height: 1 },
      runs: [{ text: 'Hello you', family: 'Test', size: 20, color: red }],
    });
    ok(target, { type: 'setSelection', ids: [] });

    const before = target.query({ type: 'exportScene' })!;
    const text = target.query({ type: 'exportSvg' })!;
    const [root] = ok(target, { type: 'addPage' }) as string[];
    ok(target, { type: 'setActivePage', id: root! });
    const pasted = ok(target, { type: 'paste', text, at: { x: 0, y: 0 } });
    const after = target.query({ type: 'exportScene', ids: pasted })!;
    compareFlat(flatten(before), flatten(after));
  });
});

// V33-A06 (unit half): the canvas paste and drop, the file import and the panel's lines.
describe('V33-A06 canvas paste, drop and the Import panel model', () => {
  const icon = svg('<rect width="10" height="10" fill="red"/>');
  const file = (name: string, text: string, type = 'image/svg+xml'): SvgFileLike => ({
    name,
    type,
    text: () => Promise.resolve(text),
  });
  const canvasLike = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    clientLeft: 0,
    clientTop: 0,
  };

  function host() {
    const target = editor();
    const pastes: unknown[] = [];
    const execute = target.execute.bind(target);
    target.execute = (command) => {
      if (command.type === 'paste') pastes.push(command);
      return execute(command);
    };
    const input = new CanvasInput(
      target,
      () => 400,
      () => canvasLike,
    );
    return { target, input, pastes };
  }

  function clipboard(data: Record<string, string>, files: SvgFileLike[] = []) {
    return {
      clipboardData: {
        getData: (format: string) => data[format] ?? '',
        setData: () => undefined,
        files,
      },
      preventDefault: () => undefined,
    };
  }

  it('reads image/svg+xml, then an SVG file, before text/plain; a fragment wins', async () => {
    const { input, pastes } = host();
    input.clipboardPaste(clipboard({ 'text/plain': 'hello', 'image/svg+xml': icon }));
    expect(pastes).toEqual([{ type: 'paste', text: icon }]);
    input.clipboardPaste(clipboard({ 'text/plain': 'hello' }, [file('a.svg', icon)]));
    await Promise.resolve();
    await Promise.resolve();
    expect(pastes[1]).toEqual({ type: 'paste', text: icon });
    input.clipboardPaste(
      clipboard({ 'text/plain': 'vector-studio/fragment\n{}', 'image/svg+xml': icon }),
    );
    expect(pastes[2]).toEqual({ type: 'paste', text: 'vector-studio/fragment\n{}' });
  });

  it('reads text/plain only in text edit mode', () => {
    const { target, input, pastes } = host();
    const [id] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      runs: [{ text: 'x', family: 'Test', size: 10, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    ok(target, { type: 'enterTextEdit', id: id!, anchor: 1, focus: 1 });
    input.clipboardPaste(clipboard({ 'text/plain': 'a', 'image/svg+xml': icon }));
    expect(pastes).toEqual([{ type: 'paste', text: 'a' }]);
  });

  it('drops SVG files at the drop point, 16 units apart, into one target', async () => {
    const { target, input } = host();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 500, height: 500 },
    });
    ok(target, { type: 'setSelection', ids: [frame!] });
    let prevented = 0;
    const transfer = {
      types: ['Files'],
      files: [
        file('a.svg', icon),
        file('notes.txt', 'x', 'text/plain'),
        file('b.SVG', icon, ''),
        file('c.svg', '<svg/>'),
      ],
      dropEffect: 'none',
    };
    const event = {
      clientX: 100,
      clientY: 50,
      dataTransfer: transfer,
      preventDefault: () => (prevented += 1),
    };
    input.dragOver(event);
    expect(transfer.dropEffect).toBe('copy');
    const outcomes = (await input.drop(event)) as SvgFileImport[];
    expect(prevented).toBe(2);
    expect(outcomes.map((entry) => [entry.name, entry.result.ok])).toEqual([
      ['a.svg', true],
      ['b.SVG', true],
      ['c.svg', false],
    ]);
    const ids = outcomes.flatMap((entry) => (entry.result.ok ? entry.result.ids : []));
    const nodes = ids.map((id) => target.query({ type: 'node', id })!);
    expect(nodes.map((node) => node.parent)).toEqual([frame, frame]);
    // Frame-local positions: centred on (100, 50), then (116, 66).
    expect(nodes.map((node) => [node.frame.x, node.frame.y])).toEqual([
      [95, 45],
      [111, 61],
    ]);
    expect(target.query({ type: 'selection' })).toEqual([ids[1]]);
    expect(importMessages(outcomes)).toEqual([
      'Imported 2 files',
      'Failed: c.svg (editor.empty-svg)',
    ]);
  });

  it('prevents every file drop and refuses a .svg file that is not SVG', async () => {
    const { input, pastes } = host();
    let prevented = 0;
    const event = {
      clientX: 0,
      clientY: 0,
      dataTransfer: {
        types: ['Files'],
        files: [file('a.png', 'x', 'image/png')],
        dropEffect: 'none',
      },
      preventDefault: () => (prevented += 1),
    };
    expect(await input.drop(event)).toEqual([]);
    expect(prevented).toBe(1);
    input.clipboardPaste(clipboard({}, [file('fake.svg', 'hello')]));
    await Promise.resolve();
    await Promise.resolve();
    expect(pastes).toEqual([]);
    expect(importMessages(await importSvgFiles(editor(), [file('fake.svg', 'hello')]))).toEqual([
      'Import failed: editor.invalid-svg',
    ]);
  });

  it('writes the panel lines', async () => {
    const target = editor();
    expect(
      importMessages(await importSvgFiles(target, [file('x.txt', 'x', 'text/plain')])),
    ).toEqual(['No SVG file']);
    expect(importMessages(await importSvgFiles(target, [file('bad.svg', '<svg')]))).toEqual([
      'Import failed: editor.invalid-svg',
    ]);
    expect(
      importMessages(
        await importSvgFiles(target, [
          file('logo.svg', svg('<image/><rect width="1" height="1"/>')),
        ]),
      ),
    ).toEqual(['Imported logo.svg', 'Skipped: image']);
  });
});
