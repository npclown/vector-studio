import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  serializeDocument,
  validateDocument,
  type DocumentV6,
  type Gradient,
  type NodeV6,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
  type StyleProps,
} from '../../packages/editor-core/src/index.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { paintAt } from '../support/e23-gradient-oracle.js';
import { expectedLayeredAt, isolationDepth } from '../support/e25-layer-oracle.js';
import { sceneLayerTree, sceneToWorld } from '../support/m4-scene-oracle.js';

// MVP M4-U4 (M4 contract, sections 3 M4-P7, 8 and 12 M4-Q17): the next-host side of M4. The
// panel's pure helpers (src/m4-appearance.ts) give the literal values of section 8 (the linear
// angle transform, the radial preset, the solid-to-gradient stops, the dash text) and the keys
// each node type takes, checked against the editor's `setStyle`; the host fixture
// `tests/fixtures/m4-appearance/host.v6.json` (`?fixture=appearance`, M4-A12's H1 to H9) loads,
// projects to the expected scene kinds and is accepted by a mirror with next-host's M4-P7
// feature set; the scene-to-oracle adapter of M4-A12 (tests/support/m4-scene-oracle.ts) gives
// the E23, E24 and E25 values at named points of that scene; and `ungroupNodes` multiplies a
// translucent group's opacity into its children (M4-Q17 (a), recommended option adopted
// 2026-10-30).

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, 'tests/fixtures', file), 'utf8');
const HOST_TEXT = read('m4-appearance/host.v6.json');

const panel = (await import(path.join(root, 'apps/next-host/src/m4-appearance.ts'))) as {
  RADIAL_TRANSFORM: Gradient['transform'];
  styleKeys: (type: NodeV6['type']) => readonly (keyof StyleProps)[];
  linearTransform: (theta: number) => Gradient['transform'];
  linearAngle: (transform: Gradient['transform']) => number;
  paintForKind: (kind: 'none' | 'solid' | 'linear' | 'radial', current: unknown) => unknown;
  addStop: (gradient: Gradient) => Gradient;
  removeStop: (gradient: Gradient, index: number) => Gradient;
  parseDash: (text: string) => Readonly<{ ok: true; pattern: number[] | null }> | null;
  dashPatch: (lead: unknown, edit: unknown) => unknown;
  parseHex: (text: string, alpha: number) => unknown;
  colorHex: (color: { r: number; g: number; b: number; a: number }) => string;
  parseNumber: (text: string, min?: number, max?: number) => number | null;
  radiiFor: (lead: readonly number[], index: number, value: number, linked: boolean) => unknown;
  common: (
    nodes: readonly NodeV6[],
    key: keyof StyleProps,
    read: (node: NodeV6) => unknown,
  ) => unknown;
  styleCommand: (ids: readonly string[], style: StyleProps) => Command;
};

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

function parsed(text: string): DocumentV6 {
  const result = validateDocument(JSON.parse(text));
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function editorWith(document: unknown): { target: Editor; events: EditorEvent[] } {
  let count = 0;
  const target = createEditor({
    document,
    ids: () => `n${++count}`,
    extensions: [starExtension],
  });
  const events: EditorEvent[] = [];
  target.subscribe((event) => events.push(event));
  return { target, events };
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));

/** Applies a projection to a mirror with next-host's feature set since M4-U4 (M4-P7). */
function nextHostMirror(document: DocumentV6, page: string) {
  const projection = projectPage(document, page, () => null);
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    dashes: 'supported',
    clips: 'supported',
    paints: 'gradient',
    groupOpacity: 'supported',
    textNodes: 'unsupported',
  });
  const result = mirror.replaceSnapshot({
    identity: { documentId: document.id, pageId: page },
    revision: 1,
    nodes: [...projection.nodes.values()],
    rootOrder: projection.rootOrder,
  });
  return { projection, status: result.status };
}

describe('M4-Q17 (a): ungroup of a translucent group', () => {
  const START = { horizontal: 'start', vertical: 'start' } as const;
  const node = (id: string, parent: string, extra: Record<string, unknown>) => ({
    id,
    name: id,
    parent,
    frame: { x: 10, y: 20, width: 100, height: 50 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    ...extra,
  });
  const rect = (id: string, parent: string, opacity: number, x = 0) =>
    node(id, parent, {
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: RED,
      stroke: null,
      opacity,
      frame: { x, y: 0, width: 40, height: 30 },
    });
  const doc = (kind: 'group' | 'maskGroup', opacity: number) => ({
    schemaVersion: 6,
    id: 'd',
    pages: [{ id: 'p', name: 'p', children: ['g'] }],
    nodes: {
      g: node('g', 'p', { type: kind, opacity, children: ['a', 'b'] }),
      // A mask group's first child is its mask source, a path (M1).
      a:
        kind === 'group'
          ? rect('a', 'g', 1)
          : node('a', 'g', {
              type: 'path',
              path: {
                verbs: ['move', 'line', 'line', 'close'],
                points: [0, 0, 1, 0, 0, 1],
                fillRule: 'nonzero',
              },
              fill: RED,
              stroke: null,
              frame: { x: 0, y: 0, width: 40, height: 30 },
            }),
      b: rect('b', 'g', 0.5, 60),
    },
  });

  it('multiplies the group opacity into each child, in one undo step', () => {
    const { target } = editorWith(doc('group', 0.5));
    const before = text(target);
    const result = target.execute({ type: 'ungroupNodes', id: 'g' });
    expect(result.ok).toBe(true);
    const after = target.query({ type: 'document' });
    expect(after.pages[0]!.children).toEqual(['a', 'b']);
    expect(after.nodes.g).toBeUndefined();
    expect(after.nodes.a).toMatchObject({ parent: 'p', opacity: 0.5, frame: { x: 10, y: 20 } });
    expect(after.nodes.b).toMatchObject({ parent: 'p', opacity: 0.25, frame: { x: 70, y: 20 } });
    expect(target.getSnapshot().history.undoDepth).toBe(1);
    target.execute({ type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('keeps the pixels where the children do not overlap (projection through the oracle)', () => {
    const before = parsed(JSON.stringify(doc('group', 0.5)));
    const { target } = editorWith(before);
    target.execute({ type: 'ungroupNodes', id: 'g' });
    const after = target.query({ type: 'document' });
    const tree = (document: DocumentV6) => {
      const projection = projectPage(document, 'p', () => null);
      return sceneLayerTree(projection);
    };
    // Interior points of `a` and of `b` (page units): the isolated group and the two leaves at
    // their multiplied opacities give the same colour over black.
    for (const [x, y] of [
      [30, 35],
      [90, 35],
    ] as const) {
      expect(expectedLayeredAt(tree(after), x, y, 1)).toEqual(
        expectedLayeredAt(tree(before), x, y, 1),
      );
    }
  });

  it('leaves the children unchanged under a group at opacity 1, and also applies to a mask group', () => {
    const { target } = editorWith(doc('group', 1));
    target.execute({ type: 'ungroupNodes', id: 'g' });
    const plain = target.query({ type: 'document' });
    expect([plain.nodes.a!.opacity, plain.nodes.b!.opacity]).toEqual([1, 0.5]);
    const masked = editorWith(doc('maskGroup', 0.5)).target;
    expect(masked.execute({ type: 'ungroupNodes', id: 'g' }).ok).toBe(true);
    const released = masked.query({ type: 'document' });
    expect([released.nodes.a!.opacity, released.nodes.b!.opacity]).toEqual([0.5, 0.25]);
  });
});

describe('M4 section 8: the panel helpers', () => {
  it('the linear angle writes the section 8 transform and t runs from 0 to 1 across the box', () => {
    expect(panel.linearTransform(0)).toEqual([1, 0, -0, 1, 0, 0.5]);
    for (const theta of [0, Math.PI / 6, Math.PI / 4, Math.PI / 2, 2, -2.5, Math.PI]) {
      const [a, b, c, d, e, f] = panel.linearTransform(theta);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const L = Math.abs(cos) + Math.abs(sin);
      expect([a, b, c, d, e, f]).toEqual([
        L * cos,
        L * sin,
        -L * sin,
        L * cos,
        0.5 - (L / 2) * cos,
        0.5 - (L / 2) * sin,
      ]);
      // Gradient space x = 0 and x = 1 map to points whose projections on the direction span
      // the unit box's extent along it.
      const direction = [cos, sin];
      const corners = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].map(([x, y]) => x! * direction[0]! + y! * direction[1]!);
      const start = e * direction[0]! + f * direction[1]!;
      const end = (a + e) * direction[0]! + (b + f) * direction[1]!;
      expect(start).toBeCloseTo(Math.min(...corners), 12);
      expect(end).toBeCloseTo(Math.max(...corners), 12);
      expect(panel.linearAngle([a, b, c, d, e, f])).toBeCloseTo(
        Math.atan2(Math.sin(theta), Math.cos(theta)),
        12,
      );
    }
    expect(panel.RADIAL_TRANSFORM).toEqual([0.5, 0, 0, 0.5, 0.5, 0.5]);
  });

  it('switching kinds writes the section 8 paints', () => {
    const half = { r: 0.2, g: 0.4, b: 0.6, a: 0.5 };
    expect(panel.paintForKind('linear', half)).toEqual({
      kind: 'linear',
      transform: panel.linearTransform(0),
      stops: [
        { offset: 0, color: half },
        { offset: 1, color: { ...half, a: 0 } },
      ],
      spread: 'pad',
    });
    expect(panel.paintForKind('radial', null)).toEqual({
      kind: 'radial',
      transform: [0.5, 0, 0, 0.5, 0.5, 0.5],
      stops: [
        { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { offset: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      spread: 'pad',
    });
    const linear = panel.paintForKind('linear', half) as Gradient;
    expect(panel.paintForKind('radial', { ...linear, spread: 'repeat' })).toEqual({
      kind: 'radial',
      transform: [0.5, 0, 0, 0.5, 0.5, 0.5],
      stops: linear.stops,
      spread: 'repeat',
    });
    expect(panel.paintForKind('solid', linear)).toEqual(half);
    expect(panel.paintForKind('solid', null)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(panel.paintForKind('none', half)).toBeNull();
  });

  it('stops: add between the last two, keep 1 to 16, remove', () => {
    const two = panel.paintForKind('linear', RED) as Gradient;
    const three = panel.addStop(two);
    expect(three.stops.map((stop) => stop.offset)).toEqual([0, 0.5, 1]);
    expect(three.stops[1]!.color).toEqual(RED);
    let many = three;
    while (many.stops.length < 16) many = panel.addStop(many);
    expect(panel.addStop(many)).toBe(many);
    const one = panel.removeStop(two, 0);
    expect(one.stops).toEqual([{ offset: 1, color: { ...RED, a: 0 } }]);
    expect(panel.removeStop(one, 0)).toBe(one);
    expect(panel.addStop(one).stops.map((stop) => stop.offset)).toEqual([1, 1]);
  });

  it('dash text, hex colours, numbers and radii', () => {
    expect(panel.parseDash('')).toEqual({ ok: true, pattern: null });
    expect(panel.parseDash(' 4, 2 1 ')).toEqual({ ok: true, pattern: [4, 2, 1] });
    for (const bad of ['0 0', '-1 2', 'x', '1 NaN', Array(17).fill('1').join(' ')])
      expect(panel.parseDash(bad)).toBeNull();
    expect(panel.dashPatch(null, { pattern: [4, 2] })).toEqual({
      dash: { pattern: [4, 2], phase: 0 },
    });
    expect(panel.dashPatch({ pattern: [4, 2], phase: 3 }, { pattern: null })).toEqual({
      dash: null,
    });
    expect(panel.dashPatch({ pattern: [4, 2], phase: 3 }, { phase: -1 })).toEqual({
      dash: { pattern: [4, 2], phase: -1 },
    });
    expect(panel.dashPatch(null, { phase: 1 })).toEqual({});
    expect(panel.parseHex('#FF8000', 0.5)).toEqual({ r: 1, g: 128 / 255, b: 0, a: 0.5 });
    expect(panel.parseHex('ff8000', 1)).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(panel.parseHex('#ff80', 1)).toBeNull();
    expect(panel.colorHex({ r: 1, g: 0.5, b: 0, a: 1 })).toBe('#ff8000');
    expect(panel.parseNumber(' 2.5 ', 0, 3)).toBe(2.5);
    expect([
      panel.parseNumber('', 0),
      panel.parseNumber('-1', 0),
      panel.parseNumber('1e999'),
    ]).toEqual([null, null, null]);
    expect(panel.radiiFor([1, 2, 3, 4], 2, 9, true)).toEqual([9, 9, 9, 9]);
    expect(panel.radiiFor([1, 2, 3, 4], 2, 9, false)).toEqual([1, 2, 9, 4]);
  });

  it("styleKeys mirrors the editor's PROPS: setStyle takes exactly those keys per type", () => {
    const document = parsed(read('m4-appearance/appearance.v6.json'));
    const byType = new Map<NodeV6['type'], NodeV6>();
    for (const value of Object.values(document.nodes)) {
      if (!byType.has(value.type)) byType.set(value.type, value);
    }
    expect([...byType.keys()].sort()).toEqual([
      'custom',
      'ellipse',
      'frame',
      'group',
      'instance',
      'line',
      'path',
      'rectangle',
      'symbol',
      'text',
    ]);
    const styles: Readonly<Record<keyof StyleProps, StyleProps>> = {
      fill: { fill: BLUE },
      stroke: { stroke: { width: 7 } },
      opacity: { opacity: 0.25 },
      cornerRadii: { cornerRadii: [1, 2, 3, 4] },
    };
    for (const [type, value] of byType) {
      const keys = panel.styleKeys(type);
      for (const key of Object.keys(styles) as (keyof StyleProps)[]) {
        const { target } = editorWith(document);
        const page = document.pages.find((entry) =>
          (function within(id: string): boolean {
            const at = document.nodes[id]!;
            return (
              at.parent === entry.id ||
              (Object.hasOwn(document.nodes, at.parent) && within(at.parent))
            );
          })(value.id),
        )!;
        target.execute({ type: 'setActivePage', id: page.id });
        const result = target.execute(panel.styleCommand([value.id], styles[key]));
        const outcome = result.ok ? 'ok' : `${result.code} ${result.path ?? ''}`;
        expect(`${type} ${key} ${outcome}`).toBe(
          `${type} ${key} ${keys.includes(key) ? 'ok' : `editor.invalid-command /style/${key}`}`,
        );
      }
    }
  });

  it('common values: one, mixed, or none', () => {
    const document = parsed(HOST_TEXT);
    const nodes = ['h1', 'h4', 'h7'].map((id) => document.nodes[id]!);
    expect(panel.common(nodes, 'opacity', (node) => node.opacity)).toEqual({ state: 'mixed' });
    expect(panel.common(nodes.slice(0, 2), 'opacity', (node) => node.opacity)).toEqual({
      state: 'one',
      value: 1,
    });
    expect(panel.common([document.nodes.h7!], 'fill', () => 0)).toEqual({ state: 'none' });
  });
});

describe('M4-A12: the host fixture and the scene-to-oracle adapter', () => {
  const document = parsed(HOST_TEXT);

  it('is canonical, loads with no diagnostic and projects every page for next-host (M4-P7)', () => {
    expect(serializeDocument(document)).toBe(HOST_TEXT);
    const { target, events } = editorWith(JSON.parse(HOST_TEXT));
    expect(text(target)).toBe(HOST_TEXT);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    for (const page of ['p1', 'p2']) expect(nextHostMirror(document, page).status).toBe('applied');
  });

  it('projects H1 to H9 as the contract names them', () => {
    const p1 = projectPage(document, 'p1', () => null).nodes;
    const p2 = projectPage(document, 'p2', () => null).nodes;
    const kind = (node: RenderNodeSnapshot | undefined) =>
      node === undefined ? 'missing' : node.kind === 'primitive' ? node.geometry.kind : node.kind;
    expect(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((id) => kind(p1.get(id)))).toEqual([
      'rectangle',
      'ellipse',
      'path',
      'path',
      'path',
      'path',
    ]);
    // H1 and H2 compose to E23's G1 and G2 paints (M4-P1); H2's is exact.
    const h1 = p1.get('h1') as Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
    const g1 = h1.style.fill as Gradient;
    for (const [index, value] of [200, 0, 0, 200, 50, 0].entries())
      expect(g1.transform[index]).toBeCloseTo(value, 10);
    const h2 = p1.get('h2') as Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
    expect((h2.style.fill as Gradient).transform).toEqual([100, 0, 0, 50, 100, 50]);
    // H4 is E24's D3 outline with D3's stroke; H5 D1 in stroke mode; H6 one fill-mode outline.
    const h4 = p1.get('h4') as Extract<RenderNodeSnapshot, { kind: 'path' }>;
    expect(h4.geometry).toEqual({
      kind: 'path',
      verbs: ['move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 200, 0, 200, 120, 0, 120],
      fillRule: 'nonzero',
    });
    expect(h4.style).toEqual({
      fill: null,
      stroke: {
        color: BLUE,
        width: 8,
        cap: 'butt',
        join: 'miter',
        miterLimit: 4,
        dash: { pattern: [40, 20], phase: 25 },
      },
    });
    const h5 = p1.get('h5') as Extract<RenderNodeSnapshot, { kind: 'path' }>;
    expect(h5.geometry.points).toEqual([0, 0, 300, 0]);
    expect(h5.style.stroke).toMatchObject({ width: 10, dash: { pattern: [30, 20], phase: 0 } });
    const h6 = p1.get('h6') as Extract<RenderNodeSnapshot, { kind: 'path' }>;
    expect(h6.style.stroke).toBeNull();
    expect(h6.style.fill).toEqual(BLUE);
    // H7 a group, H8 a mask group, H9 a frame unit, each outer container at 0.5.
    expect(['h7', 'h8', 'h9'].map((id) => p2.get(id))).toMatchObject([
      { kind: 'container', opacity: 0.5, clip: null },
      { kind: 'container', opacity: 0.5, clip: { kind: 'mask' } },
      { kind: 'container', opacity: 0.5, clip: null },
    ]);
    expect(isolationDepth(sceneLayerTree(projectPage(document, 'p2', () => null)))).toBe(1);
  });

  it('the adapter gives the E23, E24 and E25 values at named points', () => {
    const p1 = projectPage(document, 'p1', () => null);
    const p2 = projectPage(document, 'p2', () => null);
    const t1 = sceneLayerTree(p1);
    const t2 = sceneLayerTree(p2);
    const size = 1;
    const h1 = p1.nodes.get('h1') as Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
    // H1 interior: G1's paint at local (150, 50), opaque over black.
    const g1 = paintAt(h1.style.fill!, 150, 50);
    expect(expectedLayeredAt(t1, 160, 60, size)).toEqual([g1[0] * 255, g1[1] * 255, g1[2] * 255]);
    // Outside everything: black; on H1's edge: undecided.
    expect(expectedLayeredAt(t1, 900, 600, size)).toEqual([0, 0, 0]);
    expect(expectedLayeredAt(t1, 10, 60, size)).toBeNull();
    // H4 (phase 25, 40 on, 20 off): on the top edge, the gap at arc length 15 to 35 and the
    // dash from 35 to 75.
    expect(expectedLayeredAt(t1, 20 + 25, 200, size)).toEqual([0, 0, 0]);
    expect(expectedLayeredAt(t1, 20 + 55, 200, size)).toEqual([0, 0, 255]);
    // H5: D1's first dash and its first gap.
    expect(expectedLayeredAt(t1, 260 + 15, 220.25, size)).toEqual([0, 0, 255]);
    expect(expectedLayeredAt(t1, 260 + 40, 220.25, size)).toEqual([0, 0, 0]);
    // H6: a dash, a gap, and the solid head.
    expect(expectedLayeredAt(t1, 260 + 6, 290, size)).toEqual([0, 0, 255]);
    expect(expectedLayeredAt(t1, 260 + 21, 290, size)).toEqual([0, 0, 0]);
    expect(expectedLayeredAt(t1, 260 + 185, 290, size)).toEqual([0, 0, 255]);
    // H7 (O1): red alone, and the overlap at the isolated value (blue over red, then 0.5).
    expect(expectedLayeredAt(t2, 60, 60, size)).toEqual([127.5, 0, 0]);
    expect(expectedLayeredAt(t2, 200, 130, size)).toEqual([0, 0, 127.5]);
    // H8 (O5): red inside the ring, nothing in its hole or outside the source.
    expect(expectedLayeredAt(t2, 420 + 80, 70, size)).toEqual([127.5, 0, 0]);
    expect(expectedLayeredAt(t2, 420 + 210, 160, size)).toEqual([0, 0, 0]);
    expect(expectedLayeredAt(t2, 420 + 40, 70, size)).toEqual([0, 0, 0]);
    // H9 (O4): the clip's centre is where red and blue cross (blue on top, then 0.5); red
    // outside the clip is cut.
    const [cx, cy] = sceneToWorld(p2, 'h9', 120, 60);
    expect(cx).toBeCloseTo(200, 10);
    expect(cy).toBeCloseTo(460, 10);
    expect(expectedLayeredAt(t2, cx, cy, size)).toEqual([0, 0, 127.5]);
    const [ox, oy] = sceneToWorld(p2, 'h9', -100, 60);
    expect(expectedLayeredAt(t2, ox, oy, size)).toEqual([0, 0, 0]);
    const [rx, ry] = sceneToWorld(p2, 'h9', 30, 60);
    expect(expectedLayeredAt(t2, rx, ry, size)).toEqual([127.5, 0, 0]);
  });
});
