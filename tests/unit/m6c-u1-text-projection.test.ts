import type { RenderNodeSnapshot, TextLayoutPort } from '@vector-studio/contracts';
import {
  parseDocument,
  type Color,
  type DocumentV6,
  type Frame,
  type TextRun,
} from '@vector-studio/model';
import { RetainedSceneMirror } from '@vector-studio/renderer-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';
import { localTransform } from '../../packages/editor-core/src/geometry.js';
import {
  expandedId,
  frameContentId,
  projectPage,
  type PageProjection,
} from '../../packages/editor-core/src/projector.js';
import { TextLayoutCache, type TextLayouter } from '../../packages/editor-core/src/text.js';
import { createFakeTextLayout, type FakeTextLayout } from '../support/fake-text-layout.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M6c-U1 (docs/plans/mvp-m6c-gpu-text-contract.md, section 4; criterion M6c-A02): text nodes
// project as E28 `text` leaves from the editor's layout (M6c-P1, P2), expanded instance text
// included, with and without an override and under the instance scale; without a port text
// projects nothing and the editor raises `editor.text-unavailable` once per renderer attachment
// and page, reset by a load and a page switch (M6c-P3); a renderer created with `text: 'none'`
// isolates text as `editor.renderer-unsupported`; a layout generation change re-projects every
// text unit of the active page with no document event (M6c-P4); entering or leaving edit mode
// changes no scene node (M6c-P5). Layouts come from the fake port of M6a section 5: `a` to `z`
// advance 0.5 em, a space 0.25 em, Hangul 1 em, combining marks 0; a line's height is
// `lineHeight` times its largest size `m`, its baseline `top + (height − m)/2 + 0.8·m`. The
// scene literals below are committed expectations (M6a-U2 note 4: literal values in the test).
// The M6c-A03 half (E26-A09 with text) is in tests/unit/e26-u4-scoped-projection.test.ts.

const root = path.resolve(import.meta.dirname, '../..');
const TEXT_SYMBOLS = readFileSync(
  path.join(root, 'tests/fixtures/m4-appearance/migrated/text-symbols.v6.json'),
  'utf8',
);
const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const red: Color = { r: 1, g: 0, b: 0, a: 1 };
const FONT = '"Test", sans-serif';
const none = () => null;
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const FEATURES = {
  pathFills: 'supported',
  paints: 'gradient',
  dashes: 'supported',
  groupOpacity: 'supported',
  textNodes: 'supported',
} as const;

function run(text: string, size = 10, color: Color = black): TextRun {
  return { text, family: 'Test', size, color };
}

type Loose = Record<string, unknown> & { id: string };

function text(
  id: string,
  frame: Frame,
  runs: readonly TextRun[],
  props: Record<string, unknown> = {},
  parent = 'p1',
): Loose {
  return {
    id,
    name: id,
    parent,
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'text',
    runs,
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1,
    ...props,
  };
}

function rect(id: string, frame: Frame, parent = 'p1'): Loose {
  return {
    id,
    name: id,
    parent,
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
  };
}

/** Page `p1` holding `nodes` in order, and an empty page `p2`. */
function doc(nodes: Loose[]): DocumentV6 {
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [
      {
        id: 'p1',
        name: 'Page 1',
        children: nodes.filter((n) => n.parent === 'p1').map((n) => n.id),
      },
      {
        id: 'p2',
        name: 'Page 2',
        children: nodes.filter((n) => n.parent === 'p2').map((n) => n.id),
      },
    ],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

function symbols(): DocumentV6 {
  const result = parseDocument(TEXT_SYMBOLS);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function layouter(port: FakeTextLayout = createFakeTextLayout()): TextLayouter {
  const cache = new TextLayoutCache(port);
  return (node) => cache.layout(node);
}

function project(document: DocumentV6, page = 'p1', layout: TextLayouter = layouter()) {
  return projectPage(
    document,
    page,
    none,
    new Set(),
    undefined,
    new ExpansionCache(),
    undefined,
    layout,
  );
}

function leaf(projection: PageProjection, id: string): RenderNodeSnapshot {
  const node = projection.nodes.get(id);
  if (node === undefined) throw new Error(`not projected: ${JSON.stringify(id)}`);
  return node;
}

/** The base fields of a text leaf at `frame` on the page root. */
function base(id: string, frame: Frame, parentId: string | null = null) {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, frame.x, frame.y],
    visible: true,
    opacity: 1,
    kind: 'text',
    generation: 0,
    lang: 'ko',
  };
}

describe('M6c-P1 scene literals (M6c-A02)', () => {
  it('splits scene runs per line and per run, whitespace clusters included', () => {
    // "ab cd ef" at width 20: lines "ab " | "cd " | "ef"; the style runs "ab c" and "d ef".
    const frame = f(10, 20, 20, 30);
    const document = doc([
      text('t', frame, [run('ab c'), run('d ef', 10, red)], { sizing: 'fixed' }),
    ]);
    expect(leaf(project(document), 't')).toEqual({
      ...base('t', frame),
      runs: [
        {
          fontList: FONT,
          size: 10,
          color: black,
          clusters: [
            { text: 'a', x: 0, y: 8, advance: 5 },
            { text: 'b', x: 5, y: 8, advance: 5 },
            { text: ' ', x: 10, y: 8, advance: 2.5 },
          ],
        },
        {
          fontList: FONT,
          size: 10,
          color: black,
          clusters: [{ text: 'c', x: 0, y: 18, advance: 5 }],
        },
        {
          fontList: FONT,
          size: 10,
          color: red,
          clusters: [
            { text: 'd', x: 5, y: 18, advance: 5 },
            { text: ' ', x: 10, y: 18, advance: 2.5 },
          ],
        },
        {
          fontList: FONT,
          size: 10,
          color: red,
          clusters: [
            { text: 'e', x: 0, y: 28, advance: 5 },
            { text: 'f', x: 5, y: 28, advance: 5 },
          ],
        },
      ],
    });
  });

  it('projects an empty node with no runs', () => {
    const frame = f(0, 0, 0, 10);
    expect(leaf(project(doc([text('t', frame, [run('')])])), 't')).toEqual({
      ...base('t', frame),
      runs: [],
    });
  });

  it('a rotated node takes the transform of its frame and rotation', () => {
    const frame = f(0, 0, 10, 10);
    const projection = project(doc([text('t', frame, [run('ab')], { rotation: Math.PI / 2 })]));
    const node = leaf(projection, 't');
    expect(node).toEqual({
      ...base('t', frame),
      transform: localTransform(frame, Math.PI / 2),
      runs: [
        {
          fontList: FONT,
          size: 10,
          color: black,
          clusters: [
            { text: 'a', x: 0, y: 8, advance: 5 },
            { text: 'b', x: 5, y: 8, advance: 5 },
          ],
        },
      ],
    });
    // About the centre (5, 5): x' = 10 − y, y' = x.
    [0, 1, -1, 0, 10, 0].forEach((value, index) =>
      expect(node.transform[index]).toBeCloseTo(value, 12),
    );
  });

  it('a hidden node and a translucent one project their runs with their base fields', () => {
    const frame = f(3, 4, 5, 10);
    const runs = [
      { fontList: FONT, size: 10, color: black, clusters: [{ text: 'a', x: 0, y: 8, advance: 5 }] },
    ];
    const projection = project(
      doc([
        text('h', frame, [run('a')], { visible: false }),
        text('o', frame, [run('a')], { opacity: 0.5 }),
      ]),
    );
    expect(leaf(projection, 'h')).toEqual({ ...base('h', frame), visible: false, runs });
    expect(leaf(projection, 'o')).toEqual({ ...base('o', frame), opacity: 0.5, runs });
    expect(projection.rootOrder).toEqual(['h', 'o']);
  });

  it('leaves LF out and cuts a long cluster into pieces of 32 units', () => {
    // "a", LF, then `e` with 40 combining acute accents: one grapheme of 41 units, pieces [2, 34)
    // and [34, 43), the second at the same x with advance 0.
    const long = `e${'́'.repeat(40)}`;
    const frame = f(0, 0, 5, 20);
    expect(leaf(project(doc([text('t', frame, [run(`a\n${long}`)])])), 't')).toEqual({
      ...base('t', frame),
      runs: [
        {
          fontList: FONT,
          size: 10,
          color: black,
          clusters: [{ text: 'a', x: 0, y: 8, advance: 5 }],
        },
        {
          fontList: FONT,
          size: 10,
          color: black,
          clusters: [
            { text: long.slice(0, 32), x: 0, y: 18, advance: 5 },
            { text: long.slice(32), x: 0, y: 18, advance: 0 },
          ],
        },
      ],
    });
  });

  it('takes letter spacing through the positions and advances', () => {
    const frame = f(0, 0, 16, 10);
    expect(
      leaf(project(doc([text('t', frame, [run('ab')], { letterSpacing: 0.3 })])), 't'),
    ).toEqual({
      ...base('t', frame),
      runs: [
        {
          fontList: FONT,
          size: 10,
          color: black,
          clusters: [
            { text: 'a', x: 0, y: 8, advance: 8 },
            { text: 'b', x: 8, y: 8, advance: 8 },
          ],
        },
      ],
    });
  });

  it('takes centre and right alignment through the positions', () => {
    const frame = f(0, 0, 40, 10);
    const projection = project(
      doc([
        text('c', frame, [run('ab')], { sizing: 'fixed', align: 'center' }),
        text('r', frame, [run('ab')], { sizing: 'fixed', align: 'right' }),
      ]),
    );
    const clusters = (left: number) => [
      {
        fontList: FONT,
        size: 10,
        color: black,
        clusters: [
          { text: 'a', x: left, y: 8, advance: 5 },
          { text: 'b', x: left + 5, y: 8, advance: 5 },
        ],
      },
    ];
    expect(leaf(projection, 'c')).toEqual({ ...base('c', frame), runs: clusters(15) });
    expect(leaf(projection, 'r')).toEqual({ ...base('r', frame), runs: clusters(30) });
  });

  it('text leaves pass the renderer-core scene validation with text nodes supported', () => {
    const projection = project(
      doc([
        text('t', f(0, 0, 20, 30), [run('ab c'), run('d ef', 10, red)], { sizing: 'fixed' }),
        text('e', f(0, 0, 0, 10), [run('')]),
        text('l', f(0, 0, 5, 20), [run(`a\ne${'́'.repeat(40)}`)]),
        rect('r', f(0, 0, 10, 10)),
      ]),
    );
    const mirror = new RetainedSceneMirror(() => undefined, {
      pathNodes: 'supported',
      textNodes: 'supported',
    });
    const result = mirror.replaceSnapshot({
      identity: { documentId: 'doc', pageId: 'p1' },
      revision: 1,
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
    });
    expect(result.status).toBe('applied');
  });

  it('a throwing layout propagates out of the projection (M6c-P2)', () => {
    const broken: TextLayouter = () => {
      throw new Error('port fault');
    };
    expect(() => project(doc([text('t', f(0, 0, 10, 10), [run('a')])]), 'p1', broken)).toThrow(
      'port fault',
    );
  });
});

describe('M6c-P2 expanded instance text (M7-T2, M7-T3)', () => {
  // text-symbols.v6.json: source s1 (100 × 40) holds autoWidth `t1` "ab" and group g1 of fixed
  // centred `t2` "cd" + "가" (20, red); i1 is at scale 1 with `t1` overridden to "xy" in red, i2
  // at scale 2 with `t2` overridden to "zz" at 12, i3 at 1.5 × 1 with no override.
  const t2Runs = [
    {
      fontList: FONT,
      size: 10,
      color: black,
      clusters: [
        { text: 'c', x: 15, y: 18, advance: 5 },
        { text: 'd', x: 20, y: 18, advance: 5 },
      ],
    },
    { fontList: FONT, size: 20, color: red, clusters: [{ text: '가', x: 25, y: 18, advance: 20 }] },
  ];

  it('projects the source text and each instance copy under its expanded scene ID', () => {
    const projection = project(symbols(), 'page-1');
    const ab = [
      {
        fontList: FONT,
        size: 10,
        color: black,
        clusters: [
          { text: 'a', x: 0, y: 9, advance: 5 },
          { text: 'b', x: 5, y: 9, advance: 5 },
        ],
      },
    ];
    expect(leaf(projection, 't1')).toEqual({
      ...base('t1', f(0, 0, 10, 12), frameContentId('s1')),
      runs: ab,
    });
    expect(leaf(projection, 't2')).toEqual({ ...base('t2', f(0, 0, 60, 20), 'g1'), runs: t2Runs });
    // i1, scale 1: the override in red, and the source's own `t2`.
    expect(leaf(projection, expandedId('i1', 't1'))).toEqual({
      ...base(expandedId('i1', 't1'), f(0, 0, 10, 12), frameContentId('i1')),
      runs: [
        {
          fontList: FONT,
          size: 10,
          color: red,
          clusters: [
            { text: 'x', x: 0, y: 9, advance: 5 },
            { text: 'y', x: 5, y: 9, advance: 5 },
          ],
        },
      ],
    });
    expect(leaf(projection, expandedId('i1', 't2'))).toEqual({
      ...base(expandedId('i1', 't2'), f(0, 0, 60, 20), expandedId('i1', 'g1')),
      runs: t2Runs,
    });
    // i2, scale 2: `t1` at size 20 in a 20 × 24 frame; `t2` overridden, then sized 24 in 120 wide.
    expect(leaf(projection, expandedId('i2', 't1'))).toEqual({
      ...base(expandedId('i2', 't1'), f(0, 0, 20, 24), frameContentId('i2')),
      runs: [
        {
          fontList: FONT,
          size: 20,
          color: black,
          clusters: [
            { text: 'a', x: 0, y: 18, advance: 10 },
            { text: 'b', x: 10, y: 18, advance: 10 },
          ],
        },
      ],
    });
    // `t2` overridden to "zz" at 12, then sized 24: width 24 centred in 120 (left 48), height
    // 1.2 × 24, baseline 0.9 × 24 = 21.6 (exact in binary64 here).
    expect(leaf(projection, expandedId('i2', 't2'))).toEqual({
      ...base(expandedId('i2', 't2'), f(0, 0, 120, 40), expandedId('i2', 'g1')),
      runs: [
        {
          fontList: FONT,
          size: 24,
          color: black,
          clusters: [
            { text: 'z', x: 48, y: 21.6, advance: 12 },
            { text: 'z', x: 60, y: 21.6, advance: 12 },
          ],
        },
      ],
    });
    // i3 at 1.5 × 1 (non-uniform): sizes times s = √1.5 (M6a section 6.3), the auto modes
    // `fixed`, the frames' widths times 1.5. The values are the binary64 results, exact: `t1`
    // at 10s (a, b advance 5s, baseline 0.9 × 10s); `t2` in 90 wide, centred, at 10s and 20s
    // (content 30s, left (90 − 30s)/2, baseline 0.9 × 20s).
    expect(leaf(projection, expandedId('i3', 't1'))).toEqual({
      ...base(expandedId('i3', 't1'), f(0, 0, 0, 0), frameContentId('i3')),
      runs: [
        {
          fontList: FONT,
          size: 12.24744871391589,
          color: black,
          clusters: [
            { text: 'a', x: 0, y: 11.022703842524301, advance: 6.123724356957945 },
            {
              text: 'b',
              x: 6.123724356957945,
              y: 11.022703842524301,
              advance: 6.123724356957945,
            },
          ],
        },
      ],
    });
    expect(leaf(projection, expandedId('i3', 't2'))).toEqual({
      ...base(expandedId('i3', 't2'), f(0, 0, 0, 0), expandedId('i3', 'g1')),
      runs: [
        {
          fontList: FONT,
          size: 12.24744871391589,
          color: black,
          clusters: [
            {
              text: 'c',
              x: 26.628826929126163,
              y: 22.045407685048602,
              advance: 6.123724356957945,
            },
            {
              text: 'd',
              x: 32.752551286084106,
              y: 22.045407685048602,
              advance: 6.123724356957945,
            },
          ],
        },
        {
          fontList: FONT,
          size: 24.49489742783178,
          color: red,
          clusters: [
            {
              text: '가',
              x: 38.87627564304205,
              y: 22.045407685048602,
              advance: 24.49489742783178,
            },
          ],
        },
      ],
    });
    const s = Math.sqrt(1.5);
    expect([10 * s, 20 * s, 5 * s, 0.9 * 10 * s, 0.9 * 20 * s]).toEqual([
      12.24744871391589, 24.49489742783178, 6.123724356957945, 11.022703842524301,
      22.045407685048602,
    ]);
  });

  it('equal-scale copies share one layout by request key', () => {
    const port = createFakeTextLayout();
    project(symbols(), 'page-1', layouter(port));
    // Distinct requests on page 1: s1's t1 and t2 (shared by i1's t2), i1's "xy", i2's t1 and
    // "zz", i3's t1 and t2, and tp "pp".
    expect(port.layoutCalls).toBe(8);
  });
});

/** An editor on `document` with a recording renderer, its diagnostics and every event. */
function attached(
  document: DocumentV6,
  port: TextLayoutPort | null,
  features: Record<string, string> = FEATURES,
) {
  const target = createEditor({
    document,
    ids: createCounterIdSource('n'),
    ...(port === null ? {} : { textLayout: port }),
  });
  const events: EditorEvent[] = [];
  target.subscribe((event) => events.push(event));
  const renderer = new RecordingRenderer('supported', features);
  target.attachRenderer(renderer);
  const diagnostics = () => events.filter((event) => event.type === 'diagnostic');
  return { target, renderer, events, diagnostics };
}

const unavailable = (nodeIds: string[]) => ({
  type: 'diagnostic',
  code: 'editor.text-unavailable',
  reason: 'no-text-layout',
  nodeIds,
});

/** The scene node IDs `renderer` holds. */
function held(renderer: RecordingRenderer): string[] {
  const ids: string[] = [];
  for (const call of renderer.calls) {
    if (call.method === 'replaceSnapshot' && call.result.status === 'applied') {
      ids.length = 0;
      ids.push(...call.input.nodes.map((node) => node.id));
    } else if (call.method === 'applyChanges' && call.result.status === 'applied') {
      const removed = new Set(call.input.removed);
      const kept = ids.filter((id) => !removed.has(id));
      ids.length = 0;
      ids.push(...kept, ...call.input.inserted.map((node) => node.id));
    }
  }
  return ids.sort();
}

describe('M6c-P3 no port: nothing projected, editor.text-unavailable once per attachment and page', () => {
  const PAGE_1_TEXT = [
    't1',
    't2',
    'tp',
    expandedId('i1', 't1'),
    expandedId('i1', 't2'),
    expandedId('i2', 't1'),
    expandedId('i2', 't2'),
    expandedId('i3', 't1'),
    expandedId('i3', 't2'),
  ].sort();
  const PAGE_2_TEXT = [
    't3',
    expandedId('i4', 't1'),
    expandedId('i4', 't2'),
    expandedId('i5', 't3'),
  ].sort();

  it('raises it at attach with the sorted scene IDs left out, and not again on that page', () => {
    const { target, renderer, diagnostics } = attached(symbols(), null);
    expect(diagnostics()).toEqual([unavailable(PAGE_1_TEXT)]);
    expect(held(renderer).some((id) => PAGE_1_TEXT.includes(id))).toBe(false);
    expect(held(renderer)).toContain(expandedId('i1', 'r1'));
    expect(target.execute({ type: 'setNodeProps', id: 'tp', props: { opacity: 0.5 } }).ok).toBe(
      true,
    );
    expect(target.execute({ type: 'nudgeNodes', ids: ['i1', 'tp'], dx: 1, dy: 0 }).ok).toBe(true);
    expect(diagnostics()).toHaveLength(1);
  });

  it('a page switch and a load reset it; a page with no text raises none', () => {
    const { target, diagnostics } = attached(symbols(), null);
    target.execute({ type: 'setActivePage', id: 'page-2' });
    target.execute({ type: 'setActivePage', id: 'page-1' });
    expect(diagnostics()).toEqual([
      unavailable(PAGE_1_TEXT),
      unavailable(PAGE_2_TEXT),
      unavailable(PAGE_1_TEXT),
    ]);
    expect(target.execute({ type: 'loadDocument', document: symbols() }).ok).toBe(true);
    expect(diagnostics()).toHaveLength(4);
    expect(diagnostics()[3]).toEqual(unavailable(PAGE_1_TEXT));
    target.execute({ type: 'loadDocument', document: doc([rect('r', f(0, 0, 10, 10))]) });
    target.execute({ type: 'setActivePage', id: 'p2' });
    expect(diagnostics()).toHaveLength(4);
  });

  it('a text-free page that gains text by paste, or by undo, raises it then', () => {
    const { target, diagnostics } = attached(
      doc([text('t', f(0, 0, 10, 10), [run('ab')]), rect('r', f(0, 0, 10, 10), 'p2')]),
      null,
    );
    expect(diagnostics()).toEqual([unavailable(['t'])]);
    expect(target.execute({ type: 'copy', ids: ['t'] }).ok).toBe(true);
    target.execute({ type: 'setActivePage', id: 'p2' });
    expect(diagnostics()).toHaveLength(1);
    const pasted = target.execute({ type: 'paste' });
    expect(pasted.ok).toBe(true);
    const id = pasted.ok ? pasted.ids[0]! : '';
    expect(diagnostics()).toEqual([unavailable(['t']), unavailable([id])]);
    // Deleted, then back on a page whose diagnostic was reset: undo brings the text back.
    expect(target.execute({ type: 'deleteNodes', ids: [id] }).ok).toBe(true);
    target.execute({ type: 'setActivePage', id: 'p1' });
    target.execute({ type: 'setActivePage', id: 'p2' });
    expect(diagnostics()).toHaveLength(3);
    expect(target.execute({ type: 'undo' }).ok).toBe(true);
    expect(diagnostics()).toEqual([
      unavailable(['t']),
      unavailable([id]),
      unavailable(['t']),
      unavailable([id]),
    ]);
  });

  it('a renderer attached after a load raises it at its first projection, once per attachment', () => {
    const target = createEditor({ document: doc([rect('r', f(0, 0, 10, 10))]) });
    const events: EditorEvent[] = [];
    target.subscribe((event) => {
      if (event.type === 'diagnostic') events.push(event);
    });
    target.execute({
      type: 'loadDocument',
      document: doc([text('t', f(0, 0, 10, 10), [run('a')])]),
    });
    expect(events).toEqual([]);
    target.attachRenderer(new RecordingRenderer('supported', FEATURES));
    expect(events).toEqual([unavailable(['t'])]);
    target.attachRenderer(new RecordingRenderer('supported', FEATURES));
    expect(events).toEqual([unavailable(['t']), unavailable(['t'])]);
  });
});

describe('M6c-A02 renderer and layout cases', () => {
  it("a renderer with `text: 'none'` isolates text as editor.renderer-unsupported", () => {
    const { renderer, diagnostics } = attached(
      doc([
        text('t', f(0, 0, 10, 10), [run('a')]),
        rect('r', f(0, 0, 10, 10)),
        text('u', f(0, 0, 10, 10), [run('b')]),
      ]),
      createFakeTextLayout(),
      { ...FEATURES, textNodes: 'unsupported' },
    );
    expect(diagnostics()).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: ['t', 'u'],
      },
    ]);
    expect(held(renderer)).toEqual(['r']);
  });

  it('a generation change re-projects every text unit of the active page, no document event', () => {
    const port = createFakeTextLayout();
    const { target, renderer, events } = attached(symbols(), port);
    const document = target.query({ type: 'document' });
    const history = target.getSnapshot().history;
    const calls = renderer.calls.length;
    events.length = 0;
    port.bump();
    expect(events).toEqual([{ type: 'session', field: 'textLayout' }]);
    expect(target.query({ type: 'document' })).toBe(document);
    expect(target.getSnapshot().history).toEqual(history);
    const sets = renderer.calls.slice(calls);
    expect(sets.map((call) => [call.method, call.result.status])).toEqual([
      ['applyChanges', 'applied'],
    ]);
    const call = sets[0]!;
    if (call.method !== 'applyChanges') throw new Error(call.method);
    const set = call.input;
    expect(set.inserted).toEqual([]);
    expect(set.removed).toEqual([]);
    // Exactly the text leaves, source and expanded, each at the new generation.
    expect(set.updated.map((node) => node.id).sort()).toEqual(
      [
        't1',
        't2',
        'tp',
        expandedId('i1', 't1'),
        expandedId('i1', 't2'),
        expandedId('i2', 't1'),
        expandedId('i2', 't2'),
        expandedId('i3', 't1'),
        expandedId('i3', 't2'),
      ].sort(),
    );
    expect(set.updated.every((node) => node.kind === 'text' && node.generation === 1)).toBe(true);
    // Another page projects from the new generation on its switch.
    target.execute({ type: 'setActivePage', id: 'page-2' });
    const replaced = renderer.calls.at(-1)!;
    if (replaced.method !== 'replaceSnapshot') throw new Error(replaced.method);
    const texts = replaced.input.nodes.filter((node) => node.kind === 'text');
    expect(texts.map((node) => node.id).sort()).toEqual(
      ['t3', expandedId('i4', 't1'), expandedId('i4', 't2'), expandedId('i5', 't3')].sort(),
    );
    expect(texts.every((node) => node.kind === 'text' && node.generation === 1)).toBe(true);
  });

  it('a bump that changes no generation the editor has not reported sends nothing', () => {
    const port = createFakeTextLayout();
    const { renderer } = attached(doc([rect('r', f(0, 0, 10, 10))]), port);
    const calls = renderer.calls.length;
    port.bump();
    expect(renderer.calls.length).toBe(calls);
  });

  it('entering and leaving text edit mode changes no scene node (M6-G1, G5)', () => {
    const { target, renderer } = attached(
      doc([text('t', f(0, 0, 10, 10), [run('ab')])]),
      createFakeTextLayout(),
    );
    const calls = renderer.calls.length;
    expect(target.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 2 }).ok).toBe(true);
    expect(target.execute({ type: 'setTextSelection', anchor: 1, focus: 1 }).ok).toBe(true);
    expect(target.execute({ type: 'setSelection', ids: [] }).ok).toBe(true);
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(renderer.calls.length).toBe(calls);
  });

  it('a pending node draws nothing until its first input; a cancel removes it (M6c-P5)', () => {
    const target = createEditor({
      ids: createCounterIdSource('n'),
      textLayout: createFakeTextLayout(),
    });
    const renderer = new RecordingRenderer('supported', FEATURES);
    target.attachRenderer(renderer);
    const input = (event: unknown) => target.execute({ type: 'input', event } as Command);
    const modifiers = { shift: false, alt: false, meta: false, ctrl: false };
    target.execute({ type: 'setTool', tool: 'text' });
    const calls = renderer.calls.length;
    input({ kind: 'pointerdown', point: { x: 10, y: 10 }, modifiers });
    input({ kind: 'pointerup', point: { x: 10, y: 10 }, modifiers });
    input({ kind: 'compositionstart' });
    expect(target.getSnapshot().textEdit?.pending).not.toBeNull();
    // The click and the composition start send no set.
    expect(renderer.calls.length).toBe(calls);
    input({ kind: 'compositionupdate', data: '하' });
    const sets = () =>
      renderer.calls.slice(calls).flatMap((call) => (call.method === 'applyChanges' ? [call] : []));
    expect(sets()).toHaveLength(1);
    const first = sets()[0]!;
    expect(first.result.status).toBe('applied');
    expect(first.input.updated).toEqual([]);
    expect(first.input.removed).toEqual([]);
    expect(first.input.inserted).toHaveLength(1);
    const inserted = first.input.inserted[0]!;
    expect(
      inserted.kind === 'text' && inserted.runs.map((r) => r.clusters.map((c) => c.text)),
    ).toEqual([['하']]);
    // A cancel (an empty end) removes the node and its leaf.
    input({ kind: 'compositionend', data: '' });
    expect(Object.keys(target.query({ type: 'document' }).nodes)).toEqual([]);
    expect(sets()).toHaveLength(2);
    expect(sets()[1]!.input).toMatchObject({ inserted: [], updated: [], removed: [inserted.id] });
  });

  it('a bump then a throw inside a projection still relayouts and raises textLayout', () => {
    // Two bumps, then a throw, in one layout call: the error propagates out of the command
    // (M6c-P2), and the deferred relayout still runs, with one `textLayout` event per bump.
    const inner = createFakeTextLayout();
    let armed = false;
    const port: TextLayoutPort = {
      portVersion: 0,
      get generation() {
        return inner.generation;
      },
      layout(request) {
        if (armed) {
          armed = false;
          inner.bump();
          inner.bump();
          throw new Error('port fault');
        }
        return inner.layout(request);
      },
      subscribe: (listener) => inner.subscribe(listener),
    };
    const { target, renderer, events } = attached(
      doc([
        text('t', f(0, 0, 10, 10), [run('ab')], { sizing: 'fixed' }),
        rect('r', f(0, 0, 10, 10)),
      ]),
      port,
    );
    // A fixed node: the command needs no layout, so the port is first called by the projection.
    events.length = 0;
    armed = true;
    expect(() => target.execute({ type: 'setText', id: 't', start: 2, end: 2, text: 'c' })).toThrow(
      'port fault',
    );
    expect(
      events.filter((event) => event.type === 'session' && event.field === 'textLayout'),
    ).toHaveLength(2);
    const leaf = renderer.mirror.readRetainedScene()!.nodes.find((node) => node.id === 't');
    expect(leaf).toMatchObject({ kind: 'text', generation: 2 });
  });

  it('a port that bumps inside a projection is re-projected once, after that projection', () => {
    // The bump re-enters through the port listener while the projector walks an instance
    // (TextLayoutCache.lookup allows a bump during `layout`); the relayout is deferred to the end
    // of that projector action, so the change set and then one relayout set are sent, the
    // diagnostics collector is kept, and every held node equals a fresh projection.
    const inner = createFakeTextLayout();
    let armed = false;
    const port: TextLayoutPort = {
      portVersion: 0,
      get generation() {
        return inner.generation;
      },
      layout(request) {
        if (armed) {
          armed = false;
          inner.bump();
        }
        return inner.layout(request);
      },
      subscribe: (listener) => inner.subscribe(listener),
    };
    const { target, renderer, events } = attached(symbols(), port);
    target.execute({ type: 'setNodeProps', id: 'i3', props: { opacity: 0.9 } });
    const calls = renderer.calls.length;
    events.length = 0;
    armed = true;
    const result = target.execute({
      type: 'setFrames',
      frames: [{ id: 'i1', frame: f(200, 0, 130, 52) }],
    });
    expect(result.ok).toBe(true);
    expect(armed).toBe(false);
    expect(renderer.calls.slice(calls).map((call) => [call.method, call.result.status])).toEqual([
      ['applyChanges', 'applied'],
      ['applyChanges', 'applied'],
    ]);
    expect(events.map((event) => (event.type === 'session' ? event.field : event.type))).toEqual([
      'document',
      'textLayout',
    ]);
    const cache = new TextLayoutCache(inner);
    const fresh = project(target.query({ type: 'document' }), 'page-1', (node) =>
      cache.layout(node),
    );
    const scene = renderer.mirror.readRetainedScene()!.nodes;
    expect(scene.length).toBeGreaterThan(0);
    for (const node of scene)
      expect(node, JSON.stringify(node.id)).toEqual(fresh.nodes.get(node.id));
    expect(
      scene
        .filter((node) => node.kind === 'text')
        .every((node) => node.kind === 'text' && node.generation === 1),
    ).toBe(true);
  });

  it('typing re-projects the typed node through the change set', () => {
    const { target, renderer } = attached(
      doc([text('t', f(0, 0, 10, 10), [run('ab')]), rect('r', f(0, 0, 10, 10))]),
      createFakeTextLayout(),
    );
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 2, focus: 2 });
    const calls = renderer.calls.length;
    target.execute({ type: 'input', event: { kind: 'textinput', text: 'c' } });
    const set = renderer.calls.slice(calls).find((call) => call.method === 'applyChanges')!;
    if (set.method !== 'applyChanges') throw new Error(set.method);
    expect(set.input.updated.map((node) => node.id)).toEqual(['t']);
    const node = set.input.updated[0]!;
    expect(node.kind === 'text' && node.runs[0]!.clusters.map((c) => c.text)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
