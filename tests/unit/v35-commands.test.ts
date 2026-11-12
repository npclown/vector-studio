// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A03 and part of A09: the fill
// commands (C1), `setStyle` and the create commands' `fill`/`fills`/`blendMode` (S5), paste,
// boolean and ungroup (C4), the isolation count (P6) and the SVG mapping (E2).
import { validateDocument, type DocumentV8, type NodeV8 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';

type Json = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' };
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const grey = { r: 0.8, g: 0.8, b: 0.8, a: 1 };

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
    frame: { x: 0, y: 0, width: 100, height: 100 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type,
    ...(type === 'rectangle' ? { cornerRadii: [0, 0, 0, 0] } : {}),
    ...(['rectangle', 'ellipse', 'frame', 'symbol'].includes(type)
      ? { fills: [fill(red)], stroke: null }
      : {}),
    ...(['group', 'maskGroup', 'frame', 'symbol'].includes(type) ? { children: [] } : {}),
    ...(type === 'instance' ? { textOverrides: {} } : {}),
    blendMode: container ? 'passThrough' : 'normal',
    effects: [],
    ...extra,
  };
}

function doc(nodes: Json[]): DocumentV8 {
  const value = {
    schemaVersion: 8,
    id: 'd',
    pages: [
      {
        id: 'p',
        name: 'P',
        children: nodes.filter((n) => n.parent === 'p').map((n) => n.id as string),
      },
    ],
    nodes: Object.fromEntries(nodes.map((n) => [n.id as string, n] as const)),
  };
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function setup(): Editor {
  let count = 0;
  return createEditor({
    document: doc([
      node('a', 'p', 'rectangle'),
      node('b', 'p', 'ellipse', { fills: [] }),
      node('l', 'p', 'line', {
        points: [0, 0, 1, 1],
        stroke: { color: red, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: null },
        startArrow: 'none',
        endArrow: 'none',
      }),
      node('g', 'p', 'group', { children: ['c'], blendMode: 'multiply' }),
      node('c', 'g', 'rectangle'),
    ]),
    ids: () => `n${++count}`,
  });
}

const fillsOf = (target: Editor, id: string) =>
  (target.query({ type: 'node', id }) as Json | null)?.fills;
const ok = (target: Editor, command: Command) => {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.ids;
};
const fails = (target: Editor, command: Command, code: string, path?: string) => {
  const before = target.query({ type: 'document' });
  expect(target.execute(command)).toEqual(
    path === undefined ? { ok: false, code } : { ok: false, code, path },
  );
  expect(target.query({ type: 'document' })).toBe(before);
};
const depth = (target: Editor) => target.query({ type: 'history' }).undoDepth;

describe('V35-C1 addFill, setFill, removeFill, moveFill', () => {
  it('adds the default fill on top, to the nodes that take fills, as one step', () => {
    const target = setup();
    ok(target, { type: 'addFill', ids: ['a', 'b', 'l'] });
    expect(fillsOf(target, 'a')).toEqual([fill(red), fill(grey)]);
    expect(fillsOf(target, 'b')).toEqual([fill(grey)]);
    expect(fillsOf(target, 'l')).toBeUndefined();
    expect(depth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(fillsOf(target, 'a')).toEqual([fill(red)]);
    fails(target, { type: 'addFill', ids: ['l'] }, 'editor.invalid-command', '/ids');
    fails(target, { type: 'addFill', ids: ['zz'] }, 'editor.unknown-node');
  });

  it('refuses a 17th fill with editor.fill-limit', () => {
    const target = setup();
    for (let i = 1; i < 16; i += 1) ok(target, { type: 'addFill', ids: ['a'] });
    expect((fillsOf(target, 'a') as unknown[]).length).toBe(16);
    fails(target, { type: 'addFill', ids: ['a'] }, 'editor.fill-limit', '/nodes/a/fills');
  });

  it('patches the fill at an index; a change of no value records no step', () => {
    const target = setup();
    ok(target, { type: 'addFill', ids: ['a'] });
    ok(target, {
      type: 'setFill',
      ids: ['a', 'b'],
      index: 1,
      patch: { paint: blue, opacity: 0.5, visible: false, blendMode: 'screen' },
    });
    expect(fillsOf(target, 'a')).toEqual([
      fill(red),
      fill(blue, { opacity: 0.5, visible: false, blendMode: 'screen' }),
    ]);
    const steps = depth(target);
    expect(
      target.execute({ type: 'setFill', ids: ['a'], index: 1, patch: { opacity: 0.5 } }),
    ).toEqual({ ok: true, ids: [] });
    expect(depth(target)).toBe(steps);
    fails(
      target,
      { type: 'setFill', ids: ['a'], index: 5, patch: { opacity: 1 } },
      'editor.invalid-command',
      '/index',
    );
    fails(
      target,
      { type: 'setFill', ids: ['a'], index: 0, patch: { width: 1 } } as unknown as Command,
      'editor.invalid-command',
      '/patch/width',
    );
    fails(
      target,
      { type: 'setFill', ids: ['a'], index: 0, patch: { opacity: 2 } },
      'document.invalid-field',
      '/nodes/a/fills/0/opacity',
    );
    fails(
      target,
      {
        type: 'setFill',
        ids: ['a'],
        index: 0,
        patch: { blendMode: 'passThrough' },
      } as unknown as Command,
      'document.invalid-field',
      '/nodes/a/fills/0/blendMode',
    );
  });

  it('removes and moves a fill', () => {
    const target = setup();
    ok(target, { type: 'addFill', ids: ['a'] });
    ok(target, { type: 'setFill', ids: ['a'], index: 1, patch: { paint: blue } });
    ok(target, { type: 'moveFill', ids: ['a'], from: 0, to: 1 });
    expect(fillsOf(target, 'a')).toEqual([fill(blue), fill(red)]);
    ok(target, { type: 'removeFill', ids: ['a'], index: 0 });
    expect(fillsOf(target, 'a')).toEqual([fill(red)]);
    fails(target, { type: 'removeFill', ids: ['a'], index: 1 }, 'editor.invalid-command', '/index');
    fails(
      target,
      { type: 'moveFill', ids: ['a'], from: 0, to: 3 },
      'editor.invalid-command',
      '/from',
    );
  });
});

describe('V35-S5 and C1 setStyle, setNodeProps and the create commands', () => {
  it('`fill` replaces every fill by one; `fills` replaces the list; both is invalid', () => {
    const target = setup();
    ok(target, { type: 'addFill', ids: ['a'] });
    ok(target, { type: 'setStyle', ids: ['a'], style: { fill: blue } });
    expect(fillsOf(target, 'a')).toEqual([fill(blue)]);
    ok(target, { type: 'setStyle', ids: ['a'], style: { fill: null } });
    expect(fillsOf(target, 'a')).toEqual([]);
    ok(target, {
      type: 'setStyle',
      ids: ['a'],
      style: { fills: [fill(red), fill(blue)] } as never,
    });
    expect(fillsOf(target, 'a')).toEqual([fill(red), fill(blue)]);
    fails(
      target,
      { type: 'setStyle', ids: ['a'], style: { fill: red, fills: [] } },
      'editor.invalid-command',
      '/style/fills',
    );
    fails(
      target,
      { type: 'setNodeProps', id: 'a', props: { fill: red, fills: [] } },
      'editor.invalid-command',
      '/props/fills',
    );
    // A `fill` failure is reported where the caller wrote it.
    fails(
      target,
      { type: 'setNodeProps', id: 'a', props: { fill: { ...red, a: 2 } } },
      'document.invalid-field',
      '/nodes/a/fill/a',
    );
  });

  it('sets a mode; passThrough applies to containers and skips leaves', () => {
    const target = setup();
    ok(target, { type: 'setStyle', ids: ['a', 'g'], style: { blendMode: 'overlay' } as never });
    expect(target.query({ type: 'node', id: 'a' })!.blendMode).toBe('overlay');
    expect(target.query({ type: 'node', id: 'g' })!.blendMode).toBe('overlay');
    ok(target, { type: 'setStyle', ids: ['a', 'g'], style: { blendMode: 'passThrough' } as never });
    expect(target.query({ type: 'node', id: 'a' })!.blendMode).toBe('overlay');
    expect(target.query({ type: 'node', id: 'g' })!.blendMode).toBe('passThrough');
    fails(
      target,
      { type: 'setStyle', ids: ['a'], style: { blendMode: 'passThrough' } as never },
      'editor.invalid-command',
      '/style/blendMode',
    );
  });

  it('creates with one default fill, `fill`, `fills` or none, and the type’s default mode', () => {
    const target = setup();
    const frame = { x: 0, y: 0, width: 10, height: 10 };
    const [r] = ok(target, { type: 'createRectangle', frame });
    const [e] = ok(target, { type: 'createEllipse', frame, fill: blue });
    const [f] = ok(target, { type: 'createFrame', frame, fills: [fill(red), fill(blue)] } as never);
    const [n] = ok(target, { type: 'createRectangle', frame, fill: null });
    expect(fillsOf(target, r!)).toEqual([fill(grey)]);
    expect(fillsOf(target, e!)).toEqual([fill(blue)]);
    expect(fillsOf(target, f!)).toEqual([fill(red), fill(blue)]);
    expect(fillsOf(target, n!)).toEqual([]);
    expect(target.query({ type: 'node', id: r! })!.blendMode).toBe('normal');
    expect(target.query({ type: 'node', id: f! })!.blendMode).toBe('passThrough');
    fails(
      target,
      { type: 'createRectangle', frame, fill: red, fills: [] } as never,
      'editor.invalid-command',
      '/fills',
    );
  });
});

describe('V35-C4 paste, boolean, ungroup', () => {
  it('copy and paste keep fills and modes', () => {
    const target = setup();
    ok(target, { type: 'addFill', ids: ['a'] });
    ok(target, { type: 'setStyle', ids: ['a'], style: { blendMode: 'hue' } as never });
    ok(target, { type: 'copy', ids: ['a', 'g'] });
    const [a, g] = ok(target, { type: 'paste' });
    expect(fillsOf(target, a!)).toEqual(fillsOf(target, 'a'));
    expect(target.query({ type: 'node', id: a! })!.blendMode).toBe('hue');
    expect(target.query({ type: 'node', id: g! })!.blendMode).toBe('multiply');
  });

  it('a boolean result takes the bottom input’s fills and mode', () => {
    const target = setup();
    ok(target, { type: 'addFill', ids: ['a'] });
    ok(target, { type: 'setStyle', ids: ['a'], style: { blendMode: 'darken' } as never });
    const [id] = ok(target, { type: 'booleanNodes', ids: ['a', 'b'], op: 'union' });
    const result = target.query({ type: 'node', id: id! }) as NodeV8 & Json;
    expect(result.fills).toEqual([fill(red), fill(grey)]);
    expect(result.blendMode).toBe('darken');
  });

  it('ungroup of a group with a mode warns editor.ungroup-blend; passThrough does not', () => {
    const target = setup();
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    ok(target, { type: 'ungroupNodes', id: 'g' });
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([
      { type: 'diagnostic', code: 'editor.ungroup-blend', reason: 'blend-dropped', nodeIds: ['g'] },
    ]);
    expect(target.query({ type: 'node', id: 'c' })!.blendMode).toBe('normal');
    ok(target, { type: 'groupNodes', ids: ['c'], kind: 'group' });
    events.length = 0;
    const [group] = target.query({ type: 'selection' });
    ok(target, {
      type: 'ungroupNodes',
      id: group ?? target.query({ type: 'node', id: 'c' })!.parent,
    });
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
  });
});

describe('V35-P6 the isolation count', () => {
  it('counts containers with a mode other than passThrough, and a leaf mode as a layer', () => {
    const nodes: Json[] = [];
    let parent = 'p';
    for (let i = 0; i < 33; i += 1) {
      nodes.push(node(`g${i}`, parent, 'group', { children: [i < 32 ? `g${i + 1}` : 'r'] }));
      parent = `g${i}`;
    }
    nodes.push(node('r', 'g32', 'rectangle'));
    const target = createEditor({ document: doc(nodes) });
    const ids = Array.from({ length: 33 }, (_, i) => `g${i}`);
    ok(target, {
      type: 'setStyle',
      ids: ids.slice(0, 31),
      style: { blendMode: 'normal' } as never,
    });
    // At count 31 the leaf may still be a layer; at 32 it may not.
    ok(target, { type: 'setStyle', ids: ['r'], style: { blendMode: 'multiply' } as never });
    fails(
      target,
      { type: 'setStyle', ids: ['g31'], style: { blendMode: 'normal' } as never },
      'editor.isolation-depth',
      '/nodes/r/parent',
    );
    ok(target, { type: 'setStyle', ids: ['r'], style: { blendMode: 'normal' } as never });
    ok(target, { type: 'setStyle', ids: ['g31'], style: { blendMode: 'normal' } as never });
    fails(
      target,
      { type: 'setStyle', ids: ['g32'], style: { blendMode: 'normal' } as never },
      'editor.isolation-depth',
      '/nodes/r/parent',
    );
  });
});

/** `n` nested groups in `normal` mode (each isolates) holding `inner`, which sits at count `n`. */
function deep(inner: Json[], n = 32): Json[] {
  const nodes: Json[] = [];
  let parent = 'p';
  const first = inner.find((entry) => entry.parent === `g${n - 1}`)!.id as string;
  for (let i = 0; i < n; i += 1) {
    nodes.push(
      node(`g${i}`, parent, 'group', {
        children: [i < n - 1 ? `g${i + 1}` : first],
        blendMode: 'normal',
      }),
    );
    parent = `g${i}`;
  }
  return [...nodes, ...inner];
}

const blur = { kind: 'layerBlur', visible: true, radius: 4 };

describe('V35-P6 fills, effects, instances and loading', () => {
  it('refuses a fill with a mode, and expanded fills at opacity below 1, at count 32', () => {
    const target = createEditor({ document: doc(deep([node('r', 'g31', 'rectangle')])) });
    const path = '/nodes/r/parent';
    fails(
      target,
      { type: 'setFill', ids: ['r'], index: 0, patch: { blendMode: 'multiply' } },
      'editor.isolation-depth',
      path,
    );
    ok(target, { type: 'addFill', ids: ['r'] });
    fails(
      target,
      { type: 'setStyle', ids: ['r'], style: { opacity: 0.5 } },
      'editor.isolation-depth',
      path,
    );
    fails(
      target,
      { type: 'addEffect', ids: ['r'], kind: 'layerBlur' },
      'editor.isolation-depth',
      path,
    );
  });

  it('fails loadDocument for a frame background mode, and an instance’s inherited effects', () => {
    const target = createEditor({ document: doc([node('a', 'p', 'rectangle')]) });
    const load = (nodes: Json[]) =>
      target.execute({ type: 'loadDocument', document: JSON.parse(JSON.stringify(doc(nodes))) });
    expect(
      load(deep([node('f', 'g31', 'frame', { fills: [fill(red, { blendMode: 'multiply' })] })])),
    ).toEqual({ ok: false, code: 'editor.isolation-depth', path: '/nodes/f/parent' });
    expect(load(deep([node('f', 'g31', 'frame')]))).toMatchObject({ ok: true });
    const source = node('s', 'p', 'symbol', { children: ['sr'], effects: [blur] });
    expect(
      load([
        ...deep([node('i', 'g31', 'instance', { symbol: 's' })]),
        source,
        node('sr', 's', 'rectangle'),
      ]),
    ).toEqual({ ok: false, code: 'editor.isolation-depth', path: '/nodes/i/parent' });
    // An instance's background is its source's fills.
    const blended = node('s', 'p', 'symbol', {
      children: ['sr'],
      fills: [fill(red), fill(red, { blendMode: 'multiply' })],
    });
    const instanceAt = (n: number, extra: Json = {}) => [
      ...deep([node('i', `g${n - 1}`, 'instance', { symbol: 's', ...extra })], n),
      blended,
      node('sr', 's', 'rectangle'),
    ];
    const refused = (id: string) => ({
      ok: false,
      code: 'editor.isolation-depth',
      path: `/nodes/${id}/parent`,
    });
    expect(load(instanceAt(32))).toEqual(refused('i'));
    expect(load(instanceAt(31, { opacity: 0.5 }))).toEqual(refused('i'));
    expect(load(instanceAt(31))).toMatchObject({ ok: true });
    // A leaf's fill leaves sit one level lower when its P2 container is a layer.
    const fills = [fill(red), fill(red, { blendMode: 'multiply' })];
    expect(load(deep([node('r', 'g30', 'rectangle', { fills, opacity: 0.5 })], 31))).toEqual(
      refused('r'),
    );
    expect(load(deep([node('r', 'g30', 'rectangle', { fills, blendMode: 'screen' })], 31))).toEqual(
      refused('r'),
    );
    expect(load(deep([node('r', 'g30', 'rectangle', { fills })], 31))).toMatchObject({
      ok: true,
    });
  });

  it('re-checks instances when a symbol fill gets a mode', () => {
    const target = createEditor({
      document: doc([
        ...deep([node('i', 'g31', 'instance', { symbol: 's' })]),
        node('s', 'p', 'symbol', { children: ['sr'], fills: [fill(red), fill(red)] }),
        node('sr', 's', 'rectangle'),
      ]),
    });
    fails(
      target,
      { type: 'setFill', ids: ['s'], index: 1, patch: { blendMode: 'multiply' } },
      'editor.isolation-depth',
      '/nodes/i/parent',
    );
  });
});

describe('V35-S4 instances', () => {
  const instanceDoc = () =>
    doc([
      node('s', 'p', 'symbol', { children: ['r'], fills: [fill(blue)] }),
      node('r', 's', 'rectangle', { fills: [fill(red), fill(blue, { blendMode: 'multiply' })] }),
      node('i', 'p', 'instance', { symbol: 's', blendMode: 'screen' }),
    ]);

  it('exports an instance’s expanded fills and its own mode', () => {
    const target = createEditor({ document: instanceDoc() });
    const svg = target.query({ type: 'exportSvg', ids: ['i'] } as never) as unknown as string;
    expect(svg).toContain('mix-blend-mode: screen');
    expect(svg).toContain('mix-blend-mode: multiply');
  });

  it('detach makes a frame with the source’s fills and the instance’s mode', () => {
    const target = createEditor({ document: instanceDoc() });
    ok(target, { type: 'detachInstances', ids: ['i'] });
    const detached = target.query({ type: 'node', id: 'i' }) as unknown as Json;
    expect(detached.type).toBe('frame');
    expect(detached.fills).toEqual([fill(blue)]);
    expect(detached.blendMode).toBe('screen');
  });
});

describe('V35-E2 SVG', () => {
  it('maps modes to mix-blend-mode and isolates layered containers', () => {
    const target = setup();
    ok(target, { type: 'addFill', ids: ['a'] });
    ok(target, { type: 'setFill', ids: ['a'], index: 1, patch: { blendMode: 'colorDodge' } });
    const svg = target.query({ type: 'exportSvg' } as never) as unknown as string;
    expect(svg).toContain('style="mix-blend-mode: color-dodge"');
    expect(svg).toContain('style="mix-blend-mode: multiply; isolation: isolate"');
  });
});
