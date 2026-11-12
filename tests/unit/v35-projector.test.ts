// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A02 and A06: the projection
// of fills and blend modes (P1 to P6), the projector gate, and the change sets of a P1 to P2
// switch (K8).
import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { validateDocument, type DocumentV8 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { createEditor, type Command } from '../../packages/editor-core/src/index.js';
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';
import {
  fillLeafId,
  projectPage,
  strokeLeafId,
  type PageProjection,
} from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

type Json = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' };
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 0.5 };
const stroke = { color: red, width: 2, cap: 'butt', join: 'round', miterLimit: 4, dash: null };
const LINEAR = {
  kind: 'linear',
  transform: [1, 0, 0, 1, 0, 0],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'pad',
};

const fill = (paint: unknown, extra: Json = {}) => ({
  paint,
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  ...extra,
});

function node(id: string, parent: string, type: string, extra: Json = {}): Json {
  const container = ['group', 'maskGroup', 'frame', 'symbol', 'instance'].includes(type);
  return {
    id,
    name: id,
    parent,
    frame: { x: 10, y: 20, width: 40, height: 30 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type,
    ...(type === 'rectangle' ? { cornerRadii: [0, 0, 0, 0] } : {}),
    ...(['rectangle', 'ellipse', 'path', 'frame', 'symbol'].includes(type)
      ? { fills: [fill(red)], stroke: null }
      : {}),
    ...(['group', 'maskGroup', 'frame', 'symbol'].includes(type) ? { children: [] } : {}),
    blendMode: container ? 'passThrough' : 'normal',
    effects: [],
    ...extra,
  };
}

const TRIANGLE = {
  verbs: ['move', 'line', 'line', 'close'],
  points: [0, 0, 1, 0, 1, 1],
  fillRule: 'nonzero',
};

function doc(nodes: Json[]): DocumentV8 {
  const value = {
    schemaVersion: 8,
    id: 'd',
    pages: [
      { id: 'p', name: 'P', children: nodes.filter((n) => n.parent === 'p').map((n) => n.id) },
    ],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  };
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

const none = () => null;

function project(document: DocumentV8, blend: boolean): PageProjection {
  return projectPage(
    document,
    'p',
    none,
    new Set(),
    undefined,
    new ExpansionCache(),
    undefined,
    undefined,
    false,
    blend,
  );
}

const at = (projection: PageProjection, id: string): RenderNodeSnapshot => {
  const found = projection.nodes.get(id);
  if (found === undefined) throw new Error(`not projected: ${JSON.stringify(id)}`);
  return found;
};

const styleFill = (snapshot: RenderNodeSnapshot) =>
  snapshot.kind === 'primitive' || snapshot.kind === 'path' ? snapshot.style.fill : undefined;

describe('V35-P1 a single normal fill projects as one leaf', () => {
  it('folds the fill opacity into a colour and every gradient stop', () => {
    const projection = project(
      doc([
        node('a', 'p', 'rectangle', { fills: [fill(red, { opacity: 0.5 })] }),
        node('b', 'p', 'ellipse', { fills: [fill(LINEAR, { opacity: 0.25 })] }),
        // A hidden or zero fill below the drawing one does not expand the node.
        node('c', 'p', 'rectangle', {
          fills: [fill(blue, { visible: false }), fill(blue, { opacity: 0 }), fill(red)],
        }),
      ]),
      true,
    );
    expect(projection.unitIds.get('a')).toEqual(['a']);
    expect(styleFill(at(projection, 'a'))).toEqual({ ...red, a: 0.5 });
    const gradient = styleFill(at(projection, 'b')) as unknown as { stops: { color: { a: number } }[] };
    expect(gradient.stops.map((stop) => stop.color.a)).toEqual([0.25, 0.125]);
    expect(projection.unitIds.get('c')).toEqual(['c']);
    expect(styleFill(at(projection, 'c'))).toEqual(red);
  });

  it('projects no fill when none draws, and keeps the node’s own mode on the leaf', () => {
    const projection = project(
      doc([
        node('a', 'p', 'rectangle', { fills: [fill(red, { visible: false })], stroke }),
        node('b', 'p', 'rectangle', { blendMode: 'screen' }),
      ]),
      true,
    );
    expect(styleFill(at(projection, 'a'))).toBeNull();
    expect(at(projection, 'b').blendMode).toBe('screen');
    expect('blendMode' in at(projection, 'a')).toBe(false);
  });
});

describe('V35-P2 expansion', () => {
  const expanded = () =>
    doc([
      node('a', 'p', 'rectangle', {
        opacity: 0.5,
        fills: [fill(red), fill(blue, { visible: false }), fill(LINEAR, { blendMode: 'multiply' })],
        stroke,
      }),
    ]);

  it('holds a leaf per drawing fill, by its index, then the stroke leaf', () => {
    const projection = project(expanded(), true);
    const ids = ['a', fillLeafId('a', 0), fillLeafId('a', 2), strokeLeafId('a')];
    expect(fillLeafId('a', 2)).toBe('a\u0000fill2');
    expect(projection.unitIds.get('a')).toEqual(ids);
    const outer = at(projection, 'a');
    expect(outer).toMatchObject({ kind: 'container', opacity: 0.5, clip: null });
    expect(outer.kind === 'container' && outer.children).toEqual(ids.slice(1));
    // The node's `normal` is a pass-through container: no key.
    expect('blendMode' in outer).toBe(false);
    const bottom = at(projection, fillLeafId('a', 0));
    expect(bottom).toMatchObject({
      parentId: 'a',
      transform: [1, 0, 0, 1, 0, 0],
      opacity: 1,
      visible: true,
      style: { fill: red, stroke: null },
    });
    expect('blendMode' in bottom).toBe(false);
    expect(at(projection, fillLeafId('a', 2)).blendMode).toBe('multiply');
    expect(at(projection, strokeLeafId('a'))).toMatchObject({ style: { fill: null } });
    expect('blendMode' in at(projection, strokeLeafId('a'))).toBe(false);
  });

  it('puts a non-normal node mode on the container', () => {
    const value = expanded();
    const projection = project(
      { ...value, nodes: { ...value.nodes, a: { ...value.nodes.a!, blendMode: 'difference' } } },
      true,
    );
    expect(at(projection, 'a').blendMode).toBe('difference');
  });

  it('with the gate off keeps the same nodes and emits no mode (V35-P4)', () => {
    const on = project(expanded(), true);
    const off = project(expanded(), false);
    expect([...off.nodes.keys()]).toEqual([...on.nodes.keys()]);
    for (const snapshot of off.nodes.values()) expect('blendMode' in snapshot).toBe(false);
  });
});

describe('V35-P2b, P3, P5', () => {
  it('a mask source is one leaf without a mode', () => {
    const projection = project(
      doc([
        node('m', 'p', 'maskGroup', { children: ['k', 'r'] }),
        node('k', 'm', 'path', {
          path: TRIANGLE,
          fills: [fill(blue, { visible: false }), fill(red, { blendMode: 'multiply' })],
          blendMode: 'screen',
        }),
        node('r', 'm', 'rectangle'),
      ]),
      true,
    );
    expect(projection.unitIds.get('k')).toEqual(['k']);
    const source = at(projection, 'k');
    expect(source.kind).toBe('path');
    expect('blendMode' in source).toBe(false);
    expect(styleFill(source)).toEqual(red);
  });

  it('a frame’s background is one leaf per drawing fill', () => {
    const projection = project(
      doc([
        node('f', 'p', 'frame', {
          fills: [fill(red), fill(blue, { opacity: 0 }), fill(LINEAR, { blendMode: 'overlay' })],
          blendMode: 'luminosity',
        }),
      ]),
      true,
    );
    const content = at(projection, 'f\u0000content');
    expect(content.kind === 'container' && content.children).toEqual([
      'f\u0000background',
      'f\u0000background2',
    ]);
    expect(at(projection, 'f\u0000background2').blendMode).toBe('overlay');
    expect(at(projection, 'f').blendMode).toBe('luminosity');
  });

  it('a normal container isolates with the gate on; passThrough emits nothing', () => {
    const document = doc([
      node('g', 'p', 'group', { children: ['r'], blendMode: 'normal' }),
      node('r', 'g', 'rectangle'),
      node('h', 'p', 'group', { children: ['s'] }),
      node('s', 'h', 'rectangle'),
    ]);
    expect(at(project(document, true), 'g').blendMode).toBe('normal');
    expect('blendMode' in at(project(document, true), 'h')).toBe(false);
    expect('blendMode' in at(project(document, false), 'g')).toBe(false);
  });
});

describe('V35-A06 identity', () => {
  it('a scene without blending is the same value with the gate off and on', () => {
    const document = doc([
      node('g', 'p', 'group', { children: ['r', 'e'] }),
      node('r', 'g', 'rectangle', { fills: [fill(LINEAR)], stroke }),
      node('e', 'g', 'ellipse', { opacity: 0.5 }),
      node('f', 'p', 'frame', { fills: [fill(blue)] }),
    ]);
    const on = project(document, true);
    const off = project(document, false);
    expect([...on.nodes.entries()]).toEqual([...off.nodes.entries()]);
  });
});

describe('V35-K8 the change sets of an edit', () => {
  const editor = () => {
    const renderer = new RecordingRenderer('supported', { blend: 'v0' });
    const target = createEditor({
      document: doc([node('a', 'p', 'rectangle', { stroke })]),
      projectBlend: true,
    });
    target.attachRenderer(renderer);
    return { target, renderer };
  };
  const last = (renderer: RecordingRenderer) => {
    const call = renderer.calls.at(-1)!;
    expect(call.result.status).toBe('applied');
    return call.input as unknown as {
      inserted: RenderNodeSnapshot[];
      updated: RenderNodeSnapshot[];
      removed: string[];
    };
  };
  const run = (target: ReturnType<typeof createEditor>, command: Command) =>
    expect(target.execute(command).ok).toBe(true);

  it('a P1 to P2 switch updates the node and inserts its leaves, and back', () => {
    const { target, renderer } = editor();
    run(target, { type: 'addFill', ids: ['a'] });
    const added = last(renderer);
    expect(added.updated.map((n) => [n.id, n.kind])).toEqual([['a', 'container']]);
    expect(added.inserted.map((n) => n.id)).toEqual([
      fillLeafId('a', 0),
      fillLeafId('a', 1),
      strokeLeafId('a'),
    ]);
    expect(added.removed).toEqual([]);
    run(target, { type: 'removeFill', ids: ['a'], index: 1 });
    const removed = last(renderer);
    expect(removed.updated.map((n) => [n.id, n.kind])).toEqual([['a', 'primitive']]);
    expect(removed.inserted).toEqual([]);
    expect([...removed.removed].sort()).toEqual(
      [fillLeafId('a', 0), fillLeafId('a', 1), strokeLeafId('a')].sort(),
    );
  });

  it('a fill mode edit inside P2 updates that leaf only', () => {
    const { target, renderer } = editor();
    run(target, { type: 'addFill', ids: ['a'] });
    run(target, { type: 'setFill', ids: ['a'], index: 1, patch: { blendMode: 'multiply' } });
    const set = last(renderer);
    expect(set.updated.map((n) => n.id)).toEqual([fillLeafId('a', 1)]);
    expect(set.inserted).toEqual([]);
    run(target, { type: 'setStyle', ids: ['a'], style: { blendMode: 'screen' } });
    expect(last(renderer).updated.map((n) => [n.id, n.blendMode])).toEqual([['a', 'screen']]);
  });
});
