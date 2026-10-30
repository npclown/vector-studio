import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  parseDocument,
  validateDocument,
  type DocumentV6,
  type NodeV6,
  type PathData,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { createEditor, type EditorEvent } from '../../packages/editor-core/src/index.js';
import { LINE_DASH_LIMIT, lineDashes } from '../../packages/editor-core/src/line-dash.js';
import {
  QUARTER_ARC_HANDLE,
  composePaint,
  ellipseOutline,
  frameBackgroundId,
  frameBorderId,
  lineContent,
  projectPage,
  rectangleOutline,
} from '../../packages/editor-core/src/projector.js';
import { visualBounds } from '../../packages/editor-core/src/visual-bounds.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { expandDash } from '../../packages/renderer-core/src/stroke-dash.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M4 contract (docs/plans/mvp-m4-appearance-contract.md), unit M4-U2: the projection of
// paints (M4-P1), the primitive-or-path rule (M4-P3), outlines (M4-P4), dashed lines (M4-P5)
// and container opacity (M4-P6) to the E23, E24 and E25 scene surface; M4-A04 to A07 and the
// projection part of M4-A10 on directly built documents.

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures');
const read = (file: string) => readFileSync(path.join(fixtures, file), 'utf8');
const K = QUARTER_ARC_HANDLE;
const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const SKEWED = {
  kind: 'linear',
  transform: [2, 0.5, -0.25, 1, -0.5, 0.75],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'reflect',
} as const;
/** SKEWED composed in a `w × h` box, written out (M4-P1). */
const skewedIn = (w: number, h: number) => ({
  kind: 'linear',
  transform: [2 * w, 0.5 * h, -0.25 * w, 1 * h, -0.5 * w, 0.75 * h],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'reflect',
});
const RADIAL = {
  kind: 'radial',
  transform: [0.5, 0, 0, 0.5, 0.5, 0.5],
  stops: [{ offset: 0.25, color: red }],
  spread: 'pad',
} as const;
const radialIn = (w: number, h: number) => ({
  kind: 'radial',
  transform: [0.5 * w, 0, 0, 0.5 * h, 0.5 * w, 0.5 * h],
  stops: [{ offset: 0.25, color: red }],
  spread: 'pad',
});

type Loose = Record<string, unknown>;
type Styled = Extract<RenderNodeSnapshot, { kind: 'primitive' | 'path' }>;
type Path = Extract<RenderNodeSnapshot, { kind: 'path' }>;
type Join = 'miter' | 'round' | 'bevel';
type Cap = 'butt' | 'round' | 'square';

const stroke = (extra: Loose = {}): Loose => ({
  color: black,
  width: 2,
  cap: 'butt',
  join: 'round',
  miterLimit: 4,
  dash: null,
  ...extra,
});
const base = (id: string, parent: string, frame = { x: 0, y: 0, width: 100, height: 50 }) => ({
  id,
  name: id,
  parent,
  frame,
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
});
const rect = (id: string, parent: string, extra: Loose = {}): Loose => ({
  ...base(id, parent),
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: SKEWED,
  stroke: stroke(),
  ...extra,
});
const ellipse = (id: string, parent: string, extra: Loose = {}): Loose => ({
  ...base(id, parent),
  type: 'ellipse',
  fill: SKEWED,
  stroke: stroke(),
  ...extra,
});
const frame = (id: string, parent: string, extra: Loose = {}): Loose => ({
  ...base(id, parent),
  type: 'frame',
  children: [],
  fill: SKEWED,
  stroke: stroke(),
  ...extra,
});
const line = (id: string, parent: string, extra: Loose = {}): Loose => ({
  ...base(id, parent, { x: 0, y: 0, width: 100, height: 0 }),
  type: 'line',
  points: [0, 0, 1, 0],
  stroke: stroke(),
  startArrow: 'none',
  endArrow: 'none',
  ...extra,
});

/** A v6 document of `nodes` (the first `roots` on page `p`, default every parent `p` node). */
function doc(nodes: Loose[], pages: Loose[] | null = null): DocumentV6 {
  const map = Object.fromEntries(nodes.map((node) => [node.id as string, node]));
  return {
    schemaVersion: 6,
    id: 'd',
    pages: pages ?? [
      { id: 'p', name: 'P', children: nodes.filter((n) => n.parent === 'p').map((n) => n.id) },
    ],
    nodes: map,
  } as unknown as DocumentV6;
}

function valid(document: DocumentV6): DocumentV6 {
  const result = validateDocument(document);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function parsed(text: string): DocumentV6 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

const unitTriangle: PathData = {
  verbs: ['move', 'line', 'line', 'close'],
  points: [0, 0, 1, 0, 0.5, 1],
  fillRule: 'nonzero',
};
/** The custom projection the M4-A04 baseline was recorded with. */
const custom = (node: NodeV6) => (node.type === 'custom' ? unitTriangle : null);
const project = (document: DocumentV6, page = 'p') => projectPage(document, page, custom).nodes;

function mirror(): RetainedSceneMirror {
  return new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    clips: 'supported',
    paints: 'gradient',
    dashes: 'supported',
    groupOpacity: 'supported',
    textNodes: 'supported',
  });
}

/** Applies every page's projection to a mirror with every feature on; returns the statuses. */
function accepted(document: DocumentV6): string[] {
  return document.pages.map((page) => {
    const projection = projectPage(document, page.id, custom);
    const result = mirror().replaceSnapshot({
      identity: { documentId: document.id, pageId: page.id },
      revision: 1,
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
    });
    return result.status === 'invalid-scene' ? `${page.id} ${result.reason}` : result.status;
  });
}

const allFeatures = () =>
  new RecordingRenderer('supported', {
    pathFills: 'supported',
    paints: 'gradient',
    dashes: 'supported',
    groupOpacity: 'supported',
    textNodes: 'supported',
  });

/** Every committed well-formed fixture holding a document below v6 (M4-A04's set). */
function preV6Fixtures(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(fixtures, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path
      .relative(fixtures, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (file.split('/').includes('malformed')) continue;
    let value: { schemaVersion?: unknown; document?: { schemaVersion?: unknown } };
    try {
      value = JSON.parse(read(file)) as typeof value;
    } catch {
      continue;
    }
    const version =
      typeof value?.schemaVersion === 'number'
        ? value.schemaVersion
        : value?.document?.schemaVersion;
    if (typeof version === 'number' && version < 6) out.push(file);
  }
  return out.sort();
}

describe('M4-A04 projection identity against M4-U1 merge base', () => {
  const baseline = JSON.parse(read('m4-appearance/projection-baseline.json')) as {
    recordedAt: string;
    fixtures: Record<string, Record<string, unknown>>;
  };

  it('the baseline was recorded at the merge base and covers exactly the pre-v6 fixtures', () => {
    expect(baseline.recordedAt).toBe('ea41bb8');
    expect(Object.keys(baseline.fixtures).sort()).toEqual(preV6Fixtures());
  });

  it.each(preV6Fixtures())('%s migrated projects as at the merge base', (file) => {
    const value = JSON.parse(read(file)) as { schemaVersion?: number; document?: unknown };
    const document = parsed(
      JSON.stringify(value.schemaVersion === undefined ? value.document : value),
    );
    const pages = Object.fromEntries(
      document.pages.map((page) => {
        const projection = projectPage(document, page.id, custom);
        return [
          page.id,
          {
            nodes: [...projection.nodes.values()],
            rootOrder: projection.rootOrder,
            units: projection.units,
            invalid: projection.invalid,
          },
        ];
      }),
    );
    expect(pages).toEqual(baseline.fixtures[file]);
    expect(JSON.stringify(pages)).toBe(JSON.stringify(baseline.fixtures[file]));
    // No `dash` key and two-key primitive strokes anywhere (M4-P2, M4-Q14 (a)).
    expect(JSON.stringify(pages)).not.toContain('"dash"');
  });
});

describe('M4-A05 paints (M4-P1)', () => {
  it('composes a gradient as diag(w*, h*) · T and passes a colour through unchanged', () => {
    expect(composePaint(SKEWED as never, 30, 7)).toEqual(skewedIn(30, 7));
    const composed = composePaint(SKEWED, 30, 7) as { stops: readonly unknown[] };
    expect(composed.stops).not.toBe(SKEWED.stops);
    expect(Object.keys(composed)).toEqual(['kind', 'transform', 'stops', 'spread']);
    // A zero axis folds to 1.
    expect(composePaint(SKEWED as never, 0, 7)).toEqual(skewedIn(1, 7));
    expect(composePaint(SKEWED as never, 30, 0)).toEqual(skewedIn(30, 1));
    expect(composePaint(SKEWED as never, 0, 0)).toEqual(skewedIn(1, 1));
    expect(composePaint(red, 30, 7)).toBe(red);
  });

  it('composes each node kind in its own frame box', () => {
    const box = { x: 5, y: 6, width: 40, height: 25 };
    const nodes = project(
      valid(
        doc([
          rect('r', 'p', { frame: box, stroke: stroke({ color: RADIAL }) }),
          ellipse('e', 'p', { frame: box, stroke: stroke({ color: RADIAL }) }),
          {
            ...base('a', 'p', box),
            type: 'path',
            path: {
              verbs: ['move', 'line', 'line', 'close'],
              points: [0, 0, 1, 0, 0, 1],
              fillRule: 'evenodd',
            },
            fill: SKEWED,
            stroke: stroke({ color: RADIAL, join: 'miter' }),
          },
          {
            ...base('c', 'p', box),
            type: 'custom',
            customType: 'star',
            data: { points: 5, innerRadius: 0.5 },
            fill: SKEWED,
            stroke: stroke({ color: RADIAL }),
          },
          line('l', 'p', {
            frame: { x: 0, y: 0, width: 80, height: 0 },
            stroke: stroke({ color: RADIAL }),
          }),
          line('h', 'p', {
            frame: { x: 0, y: 0, width: 80, height: 0 },
            stroke: stroke({ color: SKEWED, width: 4 }),
            endArrow: 'triangle',
          }),
          frame('f', 'p', { frame: box, stroke: stroke({ color: RADIAL }) }),
        ]),
      ),
    );
    const style = (id: string) => (nodes.get(id) as Styled).style;
    for (const id of ['r', 'e', 'a', 'c']) {
      expect(style(id).fill, id).toEqual(skewedIn(40, 25));
      expect(style(id).stroke!.color, id).toEqual(radialIn(40, 25));
    }
    expect(nodes.get('r')!.kind).toBe('primitive');
    expect(nodes.get('a')!.kind).toBe('path');
    // A line's frame has height 0, folded to 1; fill mode copies the composed stroke paint
    // into the fill (U1 note 12 (a)).
    expect(style('l').stroke!.color).toEqual(radialIn(80, 1));
    expect(style('h')).toEqual({ fill: skewedIn(80, 1), stroke: null });
    // A frame's background and border compose in the frame's box.
    expect(style(frameBackgroundId('f')).fill).toEqual(skewedIn(40, 25));
    expect(style(frameBorderId('f')).stroke!.color).toEqual(radialIn(40, 25));
  });

  it('composes zero-width and zero-height boxes with the axis folded to 1', () => {
    const nodes = project(
      valid(
        doc([
          rect('w0', 'p', { frame: { x: 0, y: 0, width: 0, height: 30 } }),
          ellipse('h0', 'p', { frame: { x: 0, y: 0, width: 30, height: 0 } }),
          frame('f0', 'p', { frame: { x: 0, y: 0, width: 0, height: 0 } }),
        ]),
      ),
    );
    expect((nodes.get('w0') as Styled).style.fill).toEqual(skewedIn(1, 30));
    expect((nodes.get('h0') as Styled).style.fill).toEqual(skewedIn(30, 1));
    expect((nodes.get(frameBackgroundId('f0')) as Styled).style.fill).toEqual(skewedIn(1, 1));
  });

  it('composes an instance background and border in the instance box at scale 2', () => {
    const symbol = frame('s', 'q', {
      type: 'symbol',
      frame: { x: 0, y: 0, width: 80, height: 40 },
      stroke: stroke({ color: RADIAL, join: 'miter', dash: { pattern: [6, 3], phase: 1.5 } }),
      children: ['k'],
    });
    const child = rect('k', 's', {
      frame: { x: 10, y: 10, width: 30, height: 10 },
      stroke: stroke({
        color: RADIAL,
        width: 3,
        join: 'bevel',
        dash: { pattern: [5, 1], phase: 2 },
      }),
    });
    const instance = {
      ...base('i', 'p', { x: 0, y: 0, width: 160, height: 80 }),
      type: 'instance',
      symbol: 's',
      textOverrides: {},
    };
    const document = valid(
      doc(
        [instance, symbol, child],
        [
          { id: 'p', name: 'P', children: ['i'] },
          { id: 'q', name: 'Q', children: ['s'] },
        ],
      ),
    );
    const nodes = project(document);
    expect((nodes.get(frameBackgroundId('i')) as Styled).style.fill).toEqual(skewedIn(160, 80));
    const border = nodes.get(frameBorderId('i')) as Path;
    expect(border.kind).toBe('path');
    expect(border.style).toEqual({
      fill: null,
      stroke: {
        color: radialIn(160, 80),
        width: 2,
        cap: 'butt',
        join: 'miter',
        miterLimit: 4,
        dash: { pattern: [6, 3], phase: 1.5 },
      },
    });
    expect(border.geometry).toEqual(rectangleOutline(160, 80, [0, 0, 0, 0]));
    // M4-A10 (projection part): the expanded child is mapped to 60 × 20; its gradient follows
    // the mapped box while its width and dash stay page units.
    const expanded = nodes.get('i\u0000@k') as Path;
    expect(expanded.kind).toBe('path');
    expect(expanded.geometry).toEqual(rectangleOutline(60, 20, [0, 0, 0, 0]));
    expect(expanded.style.fill).toEqual(skewedIn(60, 20));
    expect(expanded.style.stroke).toEqual({
      color: radialIn(60, 20),
      width: 3,
      cap: 'butt',
      join: 'bevel',
      miterLimit: 4,
      dash: { pattern: [5, 1], phase: 2 },
    });
    // The source itself composes in its own box.
    const own = project(document, 'q');
    expect((own.get(frameBackgroundId('s')) as Styled).style.fill).toEqual(skewedIn(80, 40));
    expect(accepted(document)).toEqual(['applied', 'applied']);
  });

  it('accepts a model-valid large frame and isolates one whose composed gradient overflows (U1 note 12 (b))', () => {
    const big = (size: number) =>
      valid(
        doc([rect('r', 'p', { frame: { x: 0, y: 0, width: size, height: size }, stroke: null })]),
      );
    // 1e150² · det(T) is finite: the composed transform passes renderer-core's hasFiniteInverse.
    expect(accepted(big(1e150))).toEqual(['applied']);
    // At 1e160 the composed determinant overflows binary64 (M4-P1, disclosed): the node is
    // rejected as invalid-value and isolated with editor.scene-rejected.
    expect(accepted(big(1e160))).toEqual(['p invalid-value']);
    const renderer = allFeatures();
    const target = createEditor({ document: big(1e160) });
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    target.attachRenderer(renderer);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.scene-rejected',
        reason: 'invalid-value',
        nodeIds: ['r'],
      },
    ]);
  });

  it('a tiny box underflows the composed determinant and is isolated (M4-P1, review N4)', () => {
    const tiny = valid(
      doc([rect('r', 'p', { frame: { x: 0, y: 0, width: 1e-170, height: 1e-170 }, stroke: null })]),
    );
    // 1e-170² · det(T) rounds to 0 in binary64, so renderer-core rejects the transform.
    expect(accepted(tiny)).toEqual(['p invalid-value']);
  });

  it("next-host's feature set (solid paints, path fills, strokes and dashes) accepts every solid M4-P3 and M4-P5 case", () => {
    const solid = (extra: Loose = {}) => stroke({ width: 3, ...extra });
    const nodes: Loose[] = [];
    let n = 0;
    for (const join of ['miter', 'round', 'bevel'] as const) {
      for (const dash of [null, { pattern: [4, 2], phase: 1 }]) {
        n += 1;
        const s = solid({ join, dash });
        nodes.push(
          rect(`r${n}`, 'p', { fill: red, stroke: s, cornerRadii: [0, 5, 10, 0] }),
          ellipse(`e${n}`, 'p', { fill: red, stroke: s }),
          frame(`f${n}`, 'p', { fill: blue, stroke: s }),
        );
      }
    }
    for (const cap of ['butt', 'round', 'square'] as const) {
      for (const [startArrow, endArrow] of [
        ['none', 'none'],
        ['line', 'none'],
        ['line', 'triangle'],
        ['triangle', 'triangle'],
      ]) {
        n += 1;
        nodes.push(
          line(`l${n}`, 'p', {
            frame: { x: 0, y: 0, width: 120, height: 30 },
            stroke: solid({ cap, dash: { pattern: [10, 7], phase: 2 } }),
            startArrow,
            endArrow,
          }),
        );
      }
    }
    const document = valid(doc(nodes));
    const projection = projectPage(document, 'p', custom);
    expect([...projection.nodes.values()].some((node) => node.kind === 'path')).toBe(true);
    const nextHost = new RetainedSceneMirror(undefined, {
      pathNodes: 'supported',
      pathFills: 'supported',
      pathStrokes: 'supported',
      dashes: 'supported',
      clips: 'supported',
      paints: 'solid',
      groupOpacity: 'unsupported',
      textNodes: 'unsupported',
    });
    const result = nextHost.replaceSnapshot({
      identity: { documentId: 'd', pageId: 'p' },
      revision: 1,
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
    });
    expect(result.status).toBe('applied');
  });

  it('a mirror with every feature on accepts every projection built here and every fixture', () => {
    const files = [
      'm4-appearance/appearance.v6.json',
      ...preV6Fixtures().filter((file) => !file.includes('clip-33')),
    ];
    for (const file of files) {
      const value = JSON.parse(read(file)) as { schemaVersion?: number; document?: unknown };
      const document = parsed(
        JSON.stringify(value.schemaVersion === undefined ? value.document : value),
      );
      for (const status of accepted(document)) expect(status, file).toBe('applied');
    }
  });
});

describe('M4-A06 strokes: primitive or path (M4-P3) and outlines (M4-P4)', () => {
  const DASH = { pattern: [4, 2], phase: 0 };
  const cases: [Join, boolean][] = [
    ['round', false],
    ['round', true],
    ['miter', false],
    ['miter', true],
    ['bevel', false],
    ['bevel', true],
  ];

  it.each(cases)(
    'join %s, dashed %s: the rectangle, ellipse and borders choose their kind',
    (join, dashed) => {
      const s = stroke({ join, dash: dashed ? DASH : null });
      const symbolNode = frame('s', 'q', { type: 'symbol', stroke: s });
      const document = valid(
        doc(
          [
            rect('r', 'p', { stroke: s }),
            ellipse('e', 'p', { stroke: s }),
            frame('f', 'p', { stroke: s }),
            { ...base('i', 'p'), type: 'instance', symbol: 's', textOverrides: {} },
            symbolNode,
          ],
          [
            { id: 'p', name: 'P', children: ['r', 'e', 'f', 'i'] },
            { id: 'q', name: 'Q', children: ['s'] },
          ],
        ),
      );
      const nodes = new Map([...project(document), ...project(document, 'q')]);
      const rectKind = join === 'round' && !dashed ? 'primitive' : 'path';
      expect(nodes.get('r')!.kind).toBe(rectKind);
      expect(nodes.get('e')!.kind).toBe(dashed ? 'path' : 'primitive');
      for (const id of ['f', 'i', 's'])
        expect(nodes.get(frameBorderId(id))!.kind, id).toBe(rectKind);
      const full = {
        color: black,
        width: 2,
        cap: 'butt',
        join,
        miterLimit: 4,
        ...(dashed ? { dash: DASH } : {}),
      };
      if (rectKind === 'path') {
        expect(nodes.get('r')).toMatchObject({
          geometry: rectangleOutline(100, 50, [0, 0, 0, 0]),
          style: { fill: skewedIn(100, 50), stroke: full },
        });
        for (const id of ['f', 'i', 's']) {
          expect(nodes.get(frameBorderId(id))).toMatchObject({
            parentId: id,
            transform: [1, 0, 0, 1, 0, 0],
            geometry: rectangleOutline(100, 50, [0, 0, 0, 0]),
            style: { fill: null, stroke: full },
          });
        }
      } else {
        expect((nodes.get('r') as Styled).style.stroke).toEqual({ color: black, width: 2 });
      }
      if (dashed) {
        expect(nodes.get('e')).toMatchObject({
          geometry: ellipseOutline(100, 50),
          style: { fill: skewedIn(100, 50), stroke: full },
        });
      } else {
        expect((nodes.get('e') as Styled).style.stroke).toEqual({ color: black, width: 2 });
      }
      expect(accepted(document)).toEqual(['applied', 'applied']);
    },
  );

  it('zero-width and zero-height boxes stay primitives with a miter join and a dash', () => {
    const s = stroke({ join: 'miter', dash: DASH });
    for (const size of [
      { x: 0, y: 0, width: 0, height: 30 },
      { x: 0, y: 0, width: 30, height: 0 },
    ]) {
      const symbolNode = frame('s', 'q', { type: 'symbol', stroke: s, frame: size });
      const document = valid(
        doc(
          [
            rect('r', 'p', { stroke: s, frame: size }),
            ellipse('e', 'p', { stroke: s, frame: size }),
            frame('f', 'p', { stroke: s, frame: size }),
            { ...base('i', 'p', size), type: 'instance', symbol: 's', textOverrides: {} },
            symbolNode,
          ],
          [
            { id: 'p', name: 'P', children: ['r', 'e', 'f', 'i'] },
            { id: 'q', name: 'Q', children: ['s'] },
          ],
        ),
      );
      const nodes = new Map([...project(document), ...project(document, 'q')]);
      for (const id of ['r', 'e', frameBorderId('f'), frameBorderId('i'), frameBorderId('s')]) {
        expect(nodes.get(id)!.kind, id).toBe('primitive');
        expect((nodes.get(id) as Styled).style.stroke, id).toEqual({ color: black, width: 2 });
      }
    }
  });

  it('a sharp 200 × 120 rectangle is exactly E24 D3 path', () => {
    expect(rectangleOutline(200, 120, [0, 0, 0, 0])).toEqual({
      kind: 'path',
      verbs: ['move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 200, 0, 200, 120, 0, 120],
      fillRule: 'nonzero',
    });
  });

  it('a rounded rectangle starts at (tl, 0), runs clockwise with k-handles, and skips zero radii', () => {
    expect(rectangleOutline(200, 120, [10, 20, 30, 0])).toEqual({
      kind: 'path',
      verbs: ['move', 'line', 'cubic', 'line', 'cubic', 'line', 'line', 'cubic', 'close'],
      points: [
        10,
        0,
        180,
        0,
        180 + K * 20,
        0,
        200,
        20 - K * 20,
        200,
        20,
        200,
        90,
        200,
        90 + K * 30,
        170 + K * 30,
        120,
        170,
        120,
        0,
        120,
        0,
        10,
        0,
        10 - K * 10,
        10 - K * 10,
        0,
        10,
        0,
      ],
      fillRule: 'nonzero',
    });
    expect(K).toBe((4 * (Math.SQRT2 - 1)) / 3);
  });

  it('clamped radii omit zero-length lines', () => {
    // 100 × 50 with radii 50: f = 0.5, so every radius is 25 and the side lines vanish.
    const node = rect('r', 'p', {
      cornerRadii: [50, 50, 50, 50],
      stroke: stroke({ join: 'miter' }),
    });
    const projected = project(valid(doc([node]))).get('r') as Path;
    const k = K * 25;
    expect(projected.geometry).toEqual({
      kind: 'path',
      verbs: ['move', 'line', 'cubic', 'cubic', 'line', 'cubic', 'cubic', 'close'],
      points: [
        25,
        0,
        75,
        0,
        75 + k,
        0,
        100,
        25 - k,
        100,
        25,
        100,
        25 + k,
        75 + k,
        50,
        75,
        50,
        25,
        50,
        25 - k,
        50,
        0,
        25 + k,
        0,
        25,
        0,
        25 - k,
        25 - k,
        0,
        25,
        0,
      ],
      fillRule: 'nonzero',
    });
    // A 50 × 50 square of radius 25: no line at all.
    expect(rectangleOutline(50, 50, [25, 25, 25, 25]).verbs).toEqual([
      'move',
      'cubic',
      'cubic',
      'cubic',
      'cubic',
      'close',
    ]);
  });

  it('an ellipse is four cubics from (w, h/2), clockwise', () => {
    const kx = K * 60;
    const ky = K * 40;
    expect(ellipseOutline(120, 80)).toEqual({
      kind: 'path',
      verbs: ['move', 'cubic', 'cubic', 'cubic', 'cubic', 'close'],
      points: [
        120,
        40,
        120,
        40 + ky,
        60 + kx,
        80,
        60,
        80,
        60 - kx,
        80,
        0,
        40 + ky,
        0,
        40,
        0,
        40 - ky,
        60 - kx,
        0,
        60,
        0,
        60 + kx,
        0,
        120,
        40 - ky,
        120,
        40,
      ],
      fillRule: 'nonzero',
    });
  });

  it('switching join or dash switches the scene kind and back, one snapshot replaced each time', () => {
    const renderer = allFeatures();
    const target = createEditor({
      document: valid(doc([rect('r', 'p'), frame('f', 'p'), ellipse('e', 'p')])),
    });
    target.attachRenderer(renderer);
    const steps: [string, Loose, string, string][] = [
      ['r', { join: 'miter' }, 'r', 'path'],
      ['r', { join: 'round' }, 'r', 'primitive'],
      ['r', { dash: DASH }, 'r', 'path'],
      ['r', { dash: null }, 'r', 'primitive'],
      ['f', { join: 'bevel' }, frameBorderId('f'), 'path'],
      ['f', { join: 'round' }, frameBorderId('f'), 'primitive'],
      ['e', { join: 'miter' }, 'e', 'primitive'],
      ['e', { dash: DASH }, 'e', 'path'],
      ['e', { dash: null }, 'e', 'primitive'],
    ];
    for (const [id, patch, sceneId, kind] of steps) {
      const node = target.getSnapshot().document.nodes[id] as unknown as { stroke: Loose };
      const calls = renderer.calls.length;
      const result = target.execute({
        type: 'setNodeProps',
        id,
        props: { stroke: { ...node.stroke, ...patch } as never },
      });
      expect(result.ok, `${id} ${JSON.stringify(patch)}`).toBe(true);
      const sets = renderer.calls.slice(calls);
      expect(sets).toHaveLength(1);
      const set = sets[0]!;
      expect(set.method).toBe('applyChanges');
      if (set.method !== 'applyChanges') continue;
      expect(set.result.status).toBe('applied');
      expect(set.input.inserted).toEqual([]);
      expect(set.input.removed).toEqual([]);
      expect(set.input.updated.map((snapshot) => [snapshot.id, snapshot.kind])).toEqual([
        [sceneId, kind],
      ]);
    }
  });
});

/** The dashes of a dashed `M P0 L P1` from renderer-core's `expandDash`, as arc lengths. */
function rendererDashes(
  p0: [number, number],
  p1: [number, number],
  dash: { pattern: number[]; phase: number },
) {
  const result = expandDash(['move', 'line'], [...p0, ...p1], dash);
  if (result.status !== 'ok') return null;
  const out: { s0: number; s1: number }[] = [];
  const { verbs, points } = result.path;
  const at = (i: number) => Math.hypot(points[2 * i]! - p0[0], points[2 * i + 1]! - p0[1]);
  for (let i = 0; i < verbs.length; i += 2) {
    expect([verbs[i], verbs[i + 1]]).toEqual(['move', 'line']);
    out.push({ s0: at(i), s1: at(i + 1) });
  }
  return out;
}

/** The literal fill-mode pieces of a horizontal shaft at y = 0 (M4-P5), built independently. */
const H = 16;
const bar = (x0: number, x1: number, h: number) => [x0, -h, x1, -h, x1, h, x0, h];
function halfDiscPoints(x: number, out: 1 | -1, h: number): number[] {
  // From E + hN through E + h·u to E − hN; N = (0, 1) at P0 (u = −x) and (0, −1) at P1 (u = +x).
  const side = out === 1 ? -1 : 1;
  const points = [x, side * h];
  for (let k = 1; k < H; k += 1) {
    const a = (k * Math.PI) / H;
    points.push(x + h * Math.sin(a) * out, 0 + h * Math.cos(a) * side);
  }
  points.push(x, -side * h);
  return points;
}

describe('M4-A07 dashed lines (M4-P5)', () => {
  const dashed = (extra: Loose) =>
    lineContent(
      line('l', 'p', {
        stroke: stroke({ width: 2, dash: { pattern: [10, 10], phase: 0 } }),
        ...extra,
      }) as never,
    );

  it('a dashed line without heads stays in stroke mode with its dash; a line head goes to fill mode', () => {
    const content = dashed({});
    expect(content.geometry).toEqual({
      kind: 'path',
      verbs: ['move', 'line'],
      points: [0, 0, 100, 0],
      fillRule: 'nonzero',
    });
    expect(content.style.stroke).toMatchObject({ dash: { pattern: [10, 10], phase: 0 } });
    const head = dashed({ startArrow: 'line' });
    expect(head.style).toEqual({ fill: black, stroke: null });
  });

  it('butt cap, triangle end: one bar per dash on the shaft, then the solid triangle', () => {
    // L = 100, w = 2: dashes [0,10] … [80,90] and [100,100]; the shaft ends at the base, x = 92.
    const content = dashed({ endArrow: 'triangle' });
    const bars = [0, 20, 40, 60, 80].flatMap((x) => bar(x, x + 10, 1));
    expect(content.geometry.verbs).toEqual([
      ...Array.from({ length: 5 }, () => ['move', 'line', 'line', 'line', 'close']).flat(),
      'move',
      'line',
      'line',
      'close',
    ]);
    expect(content.geometry.points).toEqual([...bars, 100, 0, 92, 4, 92, -4]);
    expect(content.style).toEqual({ fill: black, stroke: null });
  });

  it('round cap, triangle start: no cap at the base cut, half discs elsewhere, a disc for a zero-length dash', () => {
    // The start triangle's base is at x = 8, so [0, 10] is cut to [8, 10] with no cap at 8;
    // [100, 100] at the bare P1 end is a zero-length dash: a full disc.
    const content = dashed({
      startArrow: 'triangle',
      stroke: stroke({ width: 2, cap: 'round', dash: { pattern: [10, 10], phase: 0 } }),
    });
    const g = content.geometry;
    const expected: number[] = [];
    const verbs: string[] = [];
    const piece = (x0: number, x1: number, cap0: boolean) => {
      verbs.push('move', 'line', 'line', 'line', 'close');
      expected.push(...bar(x0, x1, 1));
      if (cap0) {
        verbs.push('move', ...Array<string>(H).fill('line'), 'close');
        expected.push(...halfDiscPoints(x0, -1, 1));
      }
      verbs.push('move', ...Array<string>(H).fill('line'), 'close');
      expected.push(...halfDiscPoints(x1, 1, 1));
    };
    piece(8, 10, false);
    for (const x of [20, 40, 60, 80]) piece(x, x + 10, true);
    // The disc: the P1 end's half disc and its continuation through −x.
    verbs.push('move', ...Array<string>(2 * H - 1).fill('line'), 'close');
    const disc = [100, -1];
    for (let k = 1; k < 2 * H; k += 1) {
      if (k === H) {
        disc.push(100, 1);
        continue;
      }
      const a = (k * Math.PI) / H;
      disc.push(100 + Math.sin(a), 0 - Math.cos(a));
    }
    expected.push(...disc);
    verbs.push('move', 'line', 'line', 'close');
    expected.push(0, 0, 8, -4, 8, 4);
    expect(g.verbs).toEqual(verbs);
    expect(g.points.length).toBe(expected.length);
    g.points.forEach((value, index) => expect(value, `${index}`).toBeCloseTo(expected[index]!, 12));
    // The half disc's axis points are exact.
    expect(g.points.slice(8, 10)).toEqual([10, -1]);
  });

  it('square cap: dashes extend by w/2 except at the base; zero-length dashes are axis squares', () => {
    const content = dashed({
      startArrow: 'triangle',
      stroke: stroke({ width: 2, cap: 'square', dash: { pattern: [10, 10], phase: 0 } }),
    });
    const expected = [
      ...bar(8, 11, 1),
      ...[20, 40, 60, 80].flatMap((x) => bar(x - 1, x + 11, 1)),
      99,
      -1,
      101,
      -1,
      101,
      1,
      99,
      1,
      0,
      0,
      8,
      -4,
      8,
      4,
    ];
    expect(content.geometry.points).toEqual(expected);
  });

  it('dots: round discs, axis squares, nothing for butt, none at a triangle base', () => {
    // w = 2.5: the end triangle's base is at x = 90, where a dot is cut and dropped.
    const dots = (cap: Cap) =>
      lineContent(
        line('l', 'p', {
          stroke: stroke({ width: 2.5, cap, dash: { pattern: [0, 10], phase: 0 } }),
          endArrow: 'triangle',
        }) as never,
      ).geometry;
    const triangle = [100, 0, 90, 5, 90, -5];
    expect(dots('butt').points).toEqual(triangle);
    const squares = dots('square');
    expect(squares.points).toEqual([
      ...[0, 10, 20, 30, 40, 50, 60, 70, 80].flatMap((x) => [
        x - 1.25,
        -1.25,
        x + 1.25,
        -1.25,
        x + 1.25,
        1.25,
        x - 1.25,
        1.25,
      ]),
      ...triangle,
    ]);
    const discs = dots('round');
    expect(discs.verbs.filter((verb) => verb === 'move')).toHaveLength(10);
    expect(discs.points.slice(0, 2)).toEqual([0, -1.25]);
  });

  it('a rotated square-cap dot stays local-axis aligned (E24-K5 departure)', () => {
    const content = lineContent(
      line('l', 'p', {
        frame: { x: 0, y: 0, width: 30, height: 40 },
        points: [0, 0, 1, 1],
        stroke: stroke({ width: 2, cap: 'square', dash: { pattern: [0, 100], phase: 0 } }),
        endArrow: 'triangle',
      }) as never,
    );
    expect(content.geometry.points.slice(0, 8)).toEqual([-1, -1, 1, -1, 1, 1, -1, 1]);
  });

  it('a gradient stroke paint fills the fill-mode outline, composed in the frame box', () => {
    const content = dashed({
      endArrow: 'triangle',
      stroke: stroke({ color: SKEWED, dash: { pattern: [10, 10], phase: 0 } }),
    });
    expect(content.style).toEqual({ fill: skewedIn(100, 1), stroke: null });
  });

  it.each([
    [[0, 0], [300, 0], [30, 20], 0],
    [[3, 4], [303.7, -120.25], [24, 12, 6], -10],
    [[0, 0], [0, 250], [0, 20], 0],
    [[-5, 7], [95, 7.5], [5], 2.5],
    [[1, 1], [1e4, 2e3], [3, 1e-9], 7],
    [[0, 0], [123.456, 78.9], [0.1, 0.2, 0.3], 1e3],
    [[0, 0], [100, 0], [10, 10], 2 ** 40],
    [[0, 0], [100, 0], [10, 0], 3],
    [[0, 0], [100, 100], [7, 3, 0, 5], -1e6],
  ] as const)(
    'editor-core dashes on M %j L %j, pattern %j, phase %d equal expandDash within 2^-40 · L',
    (p0, p1, pattern, phase) => {
      const dash = { pattern: [...pattern], phase };
      const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const ours = lineDashes(length, dash)!;
      const theirs = rendererDashes([...p0], [...p1], dash)!;
      expect(ours.length).toBe(theirs.length);
      const bound = 2 ** -40 * length;
      ours.forEach((piece, index) => {
        expect(Math.abs(piece.s0 - theirs[index]!.s0), `s0 ${index}`).toBeLessThanOrEqual(bound);
        expect(Math.abs(piece.s1 - theirs[index]!.s1), `s1 ${index}`).toBeLessThanOrEqual(bound);
      });
    },
  );

  it('4,096 dashes stay in fill mode; 4,097 project in stroke mode with the dash and no heads', () => {
    const long = (width: number) =>
      lineContent(
        line('l', 'p', {
          frame: { x: 0, y: 0, width, height: 0 },
          stroke: stroke({ width: 0.25, dash: { pattern: [1, 1], phase: 0 } }),
          endArrow: 'triangle',
        }) as never,
      );
    // [2k, 2k + 1] for 2k ≤ L: L = 8191 has 4,096 dashes, L = 8192 one more, zero-length at L.
    expect(lineDashes(8191, { pattern: [1, 1], phase: 0 })).toHaveLength(LINE_DASH_LIMIT);
    expect(lineDashes(8192, { pattern: [1, 1], phase: 0 })).toBeNull();
    expect(
      expandDash(['move', 'line'], [0, 0, 8191, 0], { pattern: [1, 1], phase: 0 }).status,
    ).toBe('ok');
    expect(
      expandDash(['move', 'line'], [0, 0, 8192, 0], { pattern: [1, 1], phase: 0 }).status,
    ).toBe('dash-limit');
    const filled = long(8191);
    expect(filled.style.fill).toEqual(black);
    const stroked = long(8192);
    expect(stroked.geometry).toEqual({
      kind: 'path',
      verbs: ['move', 'line'],
      points: [0, 0, 8192, 0],
      fillRule: 'nonzero',
    });
    expect(stroked.style).toEqual({
      fill: null,
      stroke: {
        color: black,
        width: 0.25,
        cap: 'butt',
        join: 'round',
        miterLimit: 4,
        dash: { pattern: [1, 1], phase: 0 },
      },
    });
  });

  it('a solid-everywhere pattern draws the solid fill-mode outline', () => {
    const solid = lineContent(
      line('l', 'p', { stroke: stroke({ cap: 'round' }), endArrow: 'triangle' }) as never,
    );
    const allOn = lineContent(
      line('l', 'p', {
        stroke: stroke({ cap: 'round', dash: { pattern: [5, 0], phase: 1 } }),
        endArrow: 'triangle',
      }) as never,
    );
    expect(allOn).toEqual(solid);
  });

  it('on a diagonal line an all-on pattern matches the solid outline to rounding only (review N1)', () => {
    const diagonal = { frame: { x: 0, y: 0, width: 30, height: 40 }, points: [0, 0, 1, 1] };
    const solid = lineContent(
      line('l', 'p', {
        ...diagonal,
        stroke: stroke({ cap: 'round' }),
        endArrow: 'triangle',
      }) as never,
    );
    const allOn = lineContent(
      line('l', 'p', {
        ...diagonal,
        stroke: stroke({ cap: 'round', dash: { pattern: [5, 0], phase: 1 } }),
        endArrow: 'triangle',
      }) as never,
    );
    expect(allOn.geometry.verbs).toEqual(solid.geometry.verbs);
    allOn.geometry.points.forEach((value, index) =>
      expect(Math.abs(value - solid.geometry.points[index]!), `${index}`).toBeLessThan(1e-12),
    );
  });

  it('a dashed line with a line head: fill mode, dash bars, then the two solid head bars (review N2)', () => {
    // L = 100, w = 2, butt: dashes [0,10] … [80,90]; the zero-length dash at 100 draws nothing.
    const content = dashed({ startArrow: 'line' });
    const r = Math.sqrt(80);
    // bar((0, 0) → (8, ±4), 2): m = (8, ±4)/√80, q = (∓4, 8)/√80 · (±1 sign of m.y), h = 1.
    const head = (sy: 1 | -1) => {
      const m = { x: 8 / r, y: (sy * 4) / r };
      const q = { x: -m.y, y: m.x };
      return [0 - q.x, 0 - q.y, 8 - q.x, sy * 4 - q.y, 8 + q.x, sy * 4 + q.y, 0 + q.x, 0 + q.y];
    };
    expect(content.geometry.verbs).toEqual(
      Array.from({ length: 7 }, () => ['move', 'line', 'line', 'line', 'close']).flat(),
    );
    expect(content.geometry.points).toEqual([
      ...[0, 20, 40, 60, 80].flatMap((x) => bar(x, x + 10, 1)),
      ...head(1),
      ...head(-1),
    ]);
    expect(content.style).toEqual({ fill: black, stroke: null });
  });

  it('a dash cut at the end triangle base takes no cap there (review N2, the cut1 branch)', () => {
    // Phase 15: dashes [5,15] … [85,95]; the base is at x = 92, so the last is cut to [85, 92].
    const content = dashed({
      endArrow: 'triangle',
      stroke: stroke({ width: 2, cap: 'square', dash: { pattern: [10, 10], phase: 15 } }),
    });
    expect(content.geometry.points).toEqual([
      ...bar(4, 16, 1),
      ...bar(24, 36, 1),
      ...bar(44, 56, 1),
      ...bar(64, 76, 1),
      ...bar(84, 92, 1),
      100,
      0,
      92,
      4,
      92,
      -4,
    ]);
    const round = dashed({
      endArrow: 'triangle',
      stroke: stroke({ width: 2, cap: 'round', dash: { pattern: [10, 10], phase: 15 } }),
    }).geometry;
    // Five bars, nine half discs (none at the base), the triangle.
    expect(round.verbs.filter((verb) => verb === 'move')).toHaveLength(5 + 9 + 1);
    expect(round.points.slice(0, 8)).toEqual(bar(5, 15, 1));
    // The cut piece: its bar to the base, then only the half disc at x = 85.
    const disc = 2 * (H + 1);
    const tail = round.points.slice(-(8 + disc + 6), -6);
    expect(tail.slice(0, 8)).toEqual(bar(85, 92, 1));
    tail
      .slice(8)
      .forEach((value, index) => expect(value).toBeCloseTo(halfDiscPoints(85, -1, 1)[index]!, 12));
    expect(round.points.slice(-6)).toEqual([100, 0, 92, 4, 92, -4]);
  });

  it('every dashed-line case is accepted by the mirror', () => {
    const nodes: Loose[] = [];
    let n = 0;
    for (const cap of ['butt', 'round', 'square'] as const) {
      for (const [startArrow, endArrow] of [
        ['none', 'none'],
        ['line', 'none'],
        ['triangle', 'none'],
        ['line', 'triangle'],
        ['triangle', 'triangle'],
      ]) {
        for (const pattern of [
          [10, 10],
          [0, 7],
          [12, 18, 6],
        ]) {
          n += 1;
          nodes.push(
            line(`l${n}`, 'p', {
              frame: { x: 0, y: n * 10, width: 120, height: 30 },
              stroke: stroke({ cap, width: 3, color: SKEWED, dash: { pattern, phase: 1.5 } }),
              startArrow,
              endArrow,
            }),
          );
        }
      }
    }
    expect(accepted(valid(doc(nodes)))).toEqual(['applied']);
  });
});

describe('M4-A10 projection part and M4-P6 opacity (directly built documents)', () => {
  /** A source `s` with a dashed, gradient child; instances at scale 1 and 2. */
  const symbols = (instanceOpacity: number, childStroke: Loose = {}) =>
    doc(
      [
        {
          ...base('i1', 'p', { x: 0, y: 0, width: 80, height: 40 }),
          type: 'instance',
          symbol: 's',
          textOverrides: {},
          opacity: instanceOpacity,
        },
        {
          ...base('i2', 'p', { x: 0, y: 100, width: 160, height: 80 }),
          type: 'instance',
          symbol: 's',
          textOverrides: {},
          opacity: instanceOpacity,
        },
        frame('s', 'q', {
          type: 'symbol',
          frame: { x: 0, y: 0, width: 80, height: 40 },
          children: ['k'],
        }),
        rect('k', 's', {
          frame: { x: 10, y: 10, width: 30, height: 10 },
          stroke: stroke({
            color: RADIAL,
            width: 3,
            dash: { pattern: [5, 1], phase: 2 },
            ...childStroke,
          }),
        }),
      ],
      [
        { id: 'p', name: 'P', children: ['i1', 'i2'] },
        { id: 'q', name: 'Q', children: ['s'] },
      ],
    );

  it('an instance at opacity 0.5 projects its outer container at 0.5, isolated by the renderer', () => {
    const document = symbols(0.5);
    // M4-L1: the model rejects it until M4-U3, so it is built without validation.
    expect(validateDocument(document).ok).toBe(false);
    const nodes = project(document);
    for (const id of ['i1', 'i2']) {
      expect(nodes.get(id)).toMatchObject({ kind: 'container', opacity: 0.5 });
      expect(nodes.get(`${id}\u0000content`)).toMatchObject({ kind: 'container', opacity: 1 });
    }
    expect(accepted(document)).toEqual(['applied', 'applied']);
    const flat = new RetainedSceneMirror(undefined, {
      pathNodes: 'supported',
      pathFills: 'supported',
      pathStrokes: 'supported',
      clips: 'supported',
      paints: 'gradient',
      dashes: 'supported',
    });
    const projection = projectPage(document, 'p', custom);
    const result = flat.replaceSnapshot({
      identity: { documentId: 'd', pageId: 'p' },
      revision: 1,
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
    });
    expect(result).toMatchObject({ status: 'invalid-scene', reason: 'unsupported-feature' });
  });

  it('a source dash and stroke edit reaches instances at scales 1 and 2 with width and dash unchanged', () => {
    for (const opacity of [1, 0.5]) {
      const before = project(symbols(opacity));
      const after = project(
        symbols(opacity, { width: 5, dash: { pattern: [2, 2, 1], phase: -1 }, color: SKEWED }),
      );
      for (const [id, scale] of [
        ['i1', 1],
        ['i2', 2],
      ] as const) {
        const w = 30 * scale;
        const h = 10 * scale;
        expect((before.get(`${id}\u0000@k`) as Path).style.stroke).toEqual({
          color: radialIn(w, h),
          width: 3,
          cap: 'butt',
          join: 'round',
          miterLimit: 4,
          dash: { pattern: [5, 1], phase: 2 },
        });
        expect((after.get(`${id}\u0000@k`) as Path).style.stroke).toEqual({
          color: skewedIn(w, h),
          width: 5,
          cap: 'butt',
          join: 'round',
          miterLimit: 4,
          dash: { pattern: [2, 2, 1], phase: -1 },
        });
        expect((after.get(`${id}\u0000@k`) as Path).geometry).toEqual(
          rectangleOutline(w, h, [0, 0, 0, 0]),
        );
        expect((after.get(frameBackgroundId(id)) as Styled).style.fill).toEqual(
          skewedIn(80 * scale, 40 * scale),
        );
      }
    }
  });

  it('a source edit through the editor propagates to the instance expansion, memo kept elsewhere', () => {
    const renderer = allFeatures();
    const target = createEditor({ document: valid(symbols(1)) });
    target.attachRenderer(renderer);
    const calls = renderer.calls.length;
    const node = target.getSnapshot().document.nodes.k as unknown as { stroke: Loose };
    const result = target.execute({
      type: 'setNodeProps',
      id: 'k',
      props: { stroke: { ...node.stroke, dash: { pattern: [1, 2], phase: 0 } } as never },
    });
    expect(result.ok).toBe(true);
    // The source is on page q; the active page p holds the two instances.
    const sets = renderer.calls.slice(calls);
    expect(sets).toHaveLength(1);
    const set = sets[0]!;
    if (set.method !== 'applyChanges') throw new Error(set.method);
    expect(set.result.status).toBe('applied');
    expect(set.input.updated.map((snapshot) => snapshot.id).sort()).toEqual([
      'i1\u0000@k',
      'i2\u0000@k',
    ]);
    for (const snapshot of set.input.updated) {
      expect((snapshot as Path).style.stroke).toMatchObject({
        width: 3,
        dash: { pattern: [1, 2], phase: 0 },
      });
    }
  });

  it('frames and groups carry their opacity on the outer container only (E25-K1)', () => {
    const document = doc([
      frame('f', 'p', { opacity: 0.5, children: ['r'] }),
      rect('r', 'f', { stroke: null }),
      { ...base('g', 'p'), type: 'group', children: ['e'], opacity: 0.25 },
      ellipse('e', 'g', { stroke: null }),
    ]);
    const nodes = project(document);
    expect(nodes.get('f')).toMatchObject({ kind: 'container', opacity: 0.5 });
    expect(nodes.get('f\u0000content')).toMatchObject({ opacity: 1 });
    expect(nodes.get('g')).toMatchObject({ kind: 'container', opacity: 0.25 });
    expect(accepted(document)).toEqual(['applied']);
  });
});

describe('visual bounds of square dash caps (review S1 and N5)', () => {
  /** Every square-cap corner of a dash ending at outline point `p` with unit tangent `t`. */
  const capCorners = (p: { x: number; y: number }, t: { x: number; y: number }, h: number) => {
    const n = { x: -t.y, y: t.x };
    return [1, -1].flatMap((a) =>
      [1, -1].map((b) => ({ x: p.x + h * (a * t.x + b * n.x), y: p.y + h * (a * t.y + b * n.y) })),
    );
  };
  const inside = (
    box: { x: number; y: number; width: number; height: number },
    q: { x: number; y: number },
  ) =>
    q.x >= box.x - 1e-9 &&
    q.y >= box.y - 1e-9 &&
    q.x <= box.x + box.width + 1e-9 &&
    q.y <= box.y + box.height + 1e-9;

  it('a dashed square-cap ellipse grows by w/2 · √2, so a cap at 45° stays inside', () => {
    const node = ellipse('e', 'p', {
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: null,
      stroke: stroke({ width: 10, cap: 'square', dash: { pattern: [3, 2], phase: 0 } }),
    });
    const document = valid(doc([node]));
    const box = visualBounds(document, document.nodes.e!);
    // The review's example: the corner of a cap at 45° is at y = 5 + 5 · √2 · ... = 15.607.
    const a = Math.PI / 4;
    const corners = capCorners(
      { x: 5 + 5 * Math.cos(a), y: 5 + 5 * Math.sin(a) },
      { x: -Math.sin(a), y: Math.cos(a) },
      5,
    );
    expect(Math.max(...corners.map((q) => q.y))).toBeCloseTo(
      8.535533905932738 + 5 * Math.SQRT2,
      12,
    );
    expect(Math.max(...corners.map((q) => q.y))).toBeGreaterThan(15);
    for (let k = 0; k < 64; k += 1) {
      const t = (k * 2 * Math.PI) / 64;
      const p = { x: 5 + 5 * Math.cos(t), y: 5 + 5 * Math.sin(t) };
      for (const q of capCorners(p, { x: -Math.sin(t), y: Math.cos(t) }, 5)) {
        expect(inside(box, q), `${k}`).toBe(true);
      }
    }
    // Solid or non-square strokes keep the w/2 growth.
    for (const extra of [{ dash: null }, { cap: 'round' }, { cap: 'butt' }]) {
      const plain = valid(
        doc([
          {
            ...node,
            stroke: stroke({
              width: 10,
              cap: 'square',
              dash: { pattern: [3, 2], phase: 0 },
              ...extra,
            }),
          },
        ]),
      );
      expect(visualBounds(plain, plain.nodes.e!)).toEqual({ x: -5, y: -5, width: 20, height: 20 });
    }
  });

  it('a dashed square-cap rounded rectangle keeps every cap on its corner arcs inside', () => {
    const node = rect('r', 'p', {
      frame: { x: 0, y: 0, width: 60, height: 40 },
      cornerRadii: [10, 10, 10, 10],
      stroke: stroke({ width: 8, cap: 'square', dash: { pattern: [3, 2], phase: 0 } }),
    });
    const document = valid(doc([node]));
    const box = visualBounds(document, document.nodes.r!);
    for (const [cx, cy, from] of [
      [50, 10, -Math.PI / 2],
      [50, 30, 0],
      [10, 30, Math.PI / 2],
      [10, 10, Math.PI],
    ] as const) {
      for (let k = 0; k <= 16; k += 1) {
        const t = from + (k * Math.PI) / 32;
        const p = { x: cx + 10 * Math.cos(t), y: cy + 10 * Math.sin(t) };
        for (const q of capCorners(p, { x: -Math.sin(t), y: Math.cos(t) }, 4)) {
          expect(inside(box, q)).toBe(true);
        }
      }
    }
  });

  it('a square cap at a diagonal line head end is inside the line bounds (N5)', () => {
    for (const [startArrow, endArrow] of [
      ['line', 'triangle'],
      ['triangle', 'line'],
      ['none', 'triangle'],
    ] as const) {
      const node = line('l', 'p', {
        frame: { x: 0, y: 0, width: 100, height: 100 },
        points: [0, 0, 1, 1],
        stroke: stroke({ width: 10, cap: 'square' }),
        startArrow,
        endArrow,
      });
      const document = valid(doc([node]));
      const box = visualBounds(document, document.nodes.l!);
      const points = lineContent(document.nodes.l as never).geometry.points;
      for (let i = 0; i < points.length; i += 2) {
        expect(inside(box, { x: points[i]!, y: points[i + 1]! }), `${startArrow} ${i}`).toBe(true);
      }
    }
  });
});
