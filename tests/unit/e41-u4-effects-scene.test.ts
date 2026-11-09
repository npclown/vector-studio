import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneEffect,
} from '@vector-studio/contracts';
import {
  DIAGNOSTIC_CODES,
  SCENE_MAX_EFFECTS,
  SCENE_MAX_ISOLATION_DEPTH,
} from '@vector-studio/contracts';
import { validateDocument, type DocumentV7, type Effect } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { createEditor } from '../../packages/editor-core/src/index.js';
import {
  expandedId,
  frameContentId,
  projectPage,
  sceneEffects,
  type ProjectionMemo,
} from '../../packages/editor-core/src/projector.js';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';
import { v7Text } from '../support/schema-v7.js';

// E41-U4a (E41 contract, sections 3 and 4): the scene contract for node effects. Renderer
// validation through the retained scene mirror (E41-S5 shapes, the E41-S6 gate, the E41-S7
// isolation depth) and the projector's `effects` behind its option (E41-S4, S5, S6, S10).
// No renderer draws effects until U4b; the mirror option is set here only.

const root = path.resolve(import.meta.dirname, '../..');
const identity = { documentId: 'e41-u4', pageId: 'page' } as const;
const affine = [1, 0, 0, 1, 0, 0] as const;
const V0: RetainedSceneMirrorOptions = {
  pathNodes: 'unsupported',
  groupOpacity: 'supported',
  effects: 'v0',
};
const NONE: RetainedSceneMirrorOptions = { pathNodes: 'unsupported', groupOpacity: 'supported' };
const SHADOW: SceneEffect = {
  kind: 'dropShadow',
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 0,
  offsetY: 4,
  sigma: 4,
};
const BLUR: SceneEffect = { kind: 'layerBlur', sigma: 2 };

function container(
  id: string,
  parentId: string | null,
  children: string[],
  extra: Record<string, unknown> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'container',
    children,
    clip: null,
    ...extra,
  };
}

function rect(
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 4, height: 4, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
    ...extra,
  };
}

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  const rootOrder = nodes.filter((node) => node.parentId === null).map((node) => node.id);
  return { identity, revision, nodes, rootOrder };
}

function status(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

function replace(nodes: readonly RenderNodeSnapshot[], options = V0): string {
  return status(new RetainedSceneMirror(undefined, options).replaceSnapshot(snapshot(nodes)));
}

/** `levels` nested containers with opacity 0.5, the leaf `leaf` (with `effects`) inside. */
function chain(levels: number, effects: readonly SceneEffect[]): RenderNodeSnapshot[] {
  const nodes: RenderNodeSnapshot[] = [];
  for (let level = 0; level < levels; level += 1) {
    const child = level + 1 < levels ? `g${level + 1}` : 'leaf';
    nodes.push(
      container(`g${level}`, level === 0 ? null : `g${level - 1}`, [child], { opacity: 0.5 }),
    );
  }
  nodes.push(rect('leaf', levels === 0 ? null : `g${levels - 1}`, { effects }));
  return nodes;
}

describe('E41-S5 scene effect shapes', () => {
  it('accepts both kinds on leaves and containers, and keeps them in order', () => {
    const mirror = new RetainedSceneMirror(undefined, V0);
    const nodes = [
      container('g', null, ['r'], { effects: [BLUR, SHADOW] }),
      rect('r', 'g', { effects: [SHADOW, { ...SHADOW, offsetX: -3, sigma: 0 }] }),
    ];
    expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    const view = mirror.readRetainedScene()!;
    expect(view.getNode('g')!.effects).toEqual([BLUR, SHADOW]);
    expect(view.getNode('r')!.effects).toEqual([SHADOW, { ...SHADOW, offsetX: -3, sigma: 0 }]);
  });

  it('treats absent and empty effects alike, under either option', () => {
    for (const options of [V0, NONE]) {
      const mirror = new RetainedSceneMirror(undefined, options);
      expect(status(mirror.replaceSnapshot(snapshot([rect('r', null, { effects: [] })])))).toBe(
        'applied',
      );
      // The frozen node has no `effects` key, so the scene equals one written before E41.
      expect('effects' in mirror.readRetainedScene()!.getNode('r')!).toBe(false);
    }
  });

  it.each([
    ['not an array', { kind: 'dropShadow' }],
    ['an unknown kind', [{ kind: 'innerShadow', sigma: 1 }]],
    ['a negative sigma', [{ ...BLUR, sigma: -1 }]],
    ['an infinite sigma', [{ ...BLUR, sigma: Infinity }]],
    ['a NaN offset', [{ ...SHADOW, offsetX: Number.NaN }]],
    ['an infinite offset', [{ ...SHADOW, offsetY: -Infinity }]],
    ['a colour channel above 1', [{ ...SHADOW, color: { r: 2, g: 0, b: 0, a: 1 } }]],
    ['a colour without alpha', [{ ...SHADOW, color: { r: 0, g: 0, b: 0 } }]],
    ['an extra key', [{ ...BLUR, radius: 4 }]],
    ['a missing key', [{ kind: 'dropShadow', color: SHADOW.color, offsetX: 0, sigma: 1 }]],
    ['more than eight', Array.from({ length: SCENE_MAX_EFFECTS + 1 }, () => SHADOW)],
    ['two layer blurs', [BLUR, SHADOW, BLUR]],
  ])('rejects %s as invalid-value, under either option', (_name, effects) => {
    for (const options of [V0, NONE]) {
      expect(replace([rect('r', null, { effects })], options)).toBe('invalid-value');
      expect(replace([container('g', null, [], { effects })], options)).toBe('invalid-value');
    }
  });

  it('accepts exactly eight effects with one layer blur', () => {
    const eight = [BLUR, ...Array.from({ length: SCENE_MAX_EFFECTS - 1 }, () => SHADOW)];
    expect(replace([rect('r', null, { effects: eight })])).toBe('applied');
  });

  it('applies effect updates in change sets, and removes the key when they empty', () => {
    const mirror = new RetainedSceneMirror(undefined, V0);
    expect(status(mirror.replaceSnapshot(snapshot([rect('r', null, { effects: [SHADOW] })])))).toBe(
      'applied',
    );
    const update = (effects: readonly SceneEffect[], revision: number) =>
      status(
        mirror.applyChanges({
          identity,
          revision,
          baseRevision: revision - 1,
          inserted: [],
          updated: [rect('r', null, { effects })],
          removed: [],
          orders: [],
        }),
      );
    expect(update([{ ...SHADOW, offsetY: 5 }], 2)).toBe('applied');
    expect(mirror.readRetainedScene()!.getNode('r')!.effects).toEqual([{ ...SHADOW, offsetY: 5 }]);
    expect(update([], 3)).toBe('applied');
    expect('effects' in mirror.readRetainedScene()!.getNode('r')!).toBe(false);
  });

  it('adds render.effect-resource-limit to the diagnostic codes (E41-S8)', () => {
    expect(DIAGNOSTIC_CODES.EFFECT_RESOURCE_LIMIT).toBe('render.effect-resource-limit');
  });
});

describe('E41-S6 gate', () => {
  it('rejects non-empty effects without the option, on every node kind', () => {
    expect(replace([rect('r', null, { effects: [SHADOW] })], NONE)).toBe('unsupported-feature');
    expect(replace([container('g', null, [], { effects: [BLUR] })], NONE)).toBe(
      'unsupported-feature',
    );
    // A hidden node is still a scene value with effects.
    expect(replace([rect('r', null, { effects: [SHADOW], visible: false })], NONE)).toBe(
      'unsupported-feature',
    );
    expect(replace([rect('r', null, { effects: [SHADOW] })], V0)).toBe('applied');
  });

  it('applies the gate to change sets', () => {
    const mirror = new RetainedSceneMirror(undefined, NONE);
    expect(status(mirror.replaceSnapshot(snapshot([rect('r', null)])))).toBe('applied');
    const result = mirror.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [rect('r', null, { effects: [SHADOW] })],
      removed: [],
      orders: [],
    });
    expect(status(result)).toBe('unsupported-feature');
  });
});

describe('E41-S7 isolation depth', () => {
  const max = SCENE_MAX_ISOLATION_DEPTH;

  it('counts a container effect root with opacity 1 as isolating', () => {
    // max isolating containers above a leaf are allowed (E25-S2); one more is not.
    const nodes = chain(max, []);
    expect(replace(nodes)).toBe('applied');
    const deeper = [
      container('top', null, ['g0'], { effects: [SHADOW] }),
      ...nodes.map((node) => (node.id === 'g0' ? { ...node, parentId: 'top' } : node)),
    ];
    expect(replace(deeper)).toBe('unsupported-feature');
  });

  it('gives a leaf effect root one layer of its own', () => {
    expect(replace(chain(max - 1, [SHADOW]))).toBe('applied');
    expect(replace(chain(max, [SHADOW]))).toBe('unsupported-feature');
    expect(replace(chain(max, []))).toBe('applied');
  });

  it('does not count hidden effect roots or ones with opacity 0', () => {
    const hidden = chain(max, [SHADOW]).map((node) =>
      node.id === 'leaf' ? { ...node, visible: false } : node,
    );
    expect(replace(hidden)).toBe('applied');
    const transparent = chain(max, [SHADOW]).map((node) =>
      node.id === 'leaf' ? { ...node, opacity: 0 } : node,
    );
    expect(replace(transparent)).toBe('applied');
  });

  it('checks the depth in change sets that only add effects', () => {
    const mirror = new RetainedSceneMirror(undefined, V0);
    expect(status(mirror.replaceSnapshot(snapshot(chain(max, []))))).toBe('applied');
    const leaf = chain(max, [SHADOW]).find((node) => node.id === 'leaf')!;
    const result = mirror.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [leaf],
      removed: [],
      orders: [],
    });
    expect(status(result)).toBe('unsupported-feature');
    // And on a container: g0 gains effects with opacity 1 after its opacity changes.
    const mirror2 = new RetainedSceneMirror(undefined, V0);
    const flat = chain(max, []).map((node) => (node.id === 'g0' ? { ...node, opacity: 1 } : node));
    const top = container('top', null, ['g0'], { opacity: 0.5 });
    const nodes = [
      top,
      ...flat.map((node) => (node.id === 'g0' ? { ...node, parentId: 'top' } : node)),
    ];
    expect(status(mirror2.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    const g0 = nodes.find((node) => node.id === 'g0')!;
    const added = mirror2.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [{ ...g0, effects: [BLUR] }],
      removed: [],
      orders: [],
    });
    expect(status(added)).toBe('unsupported-feature');
  });
});

// ---------------------------------------------------------------------------------------------
// Projector (E41-S4 units, S5 placement, S6 option, S10 instances).

const START = { horizontal: 'start', vertical: 'start' } as const;
const red = { r: 1, g: 0, b: 0, a: 1 };
const DOC_SHADOW: Effect = {
  kind: 'dropShadow',
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 2,
  offsetY: 4,
  radius: 8,
};
const DOC_BLUR: Effect = { kind: 'layerBlur', visible: true, radius: 3 };

const base = (id: string, parent: string, effects: Effect[]) => ({
  id,
  name: id,
  parent,
  frame: { x: 10, y: 20, width: 40, height: 30 },
  rotation: 0.5,
  constraints: START,
  opacity: 1,
  visible: true,
  effects,
});
const docPath = (id: string, parent: string, effects: Effect[]) => ({
  ...base(id, parent, effects),
  type: 'path',
  path: {
    verbs: ['move', 'line', 'line', 'close'],
    points: [0, 0, 1, 0, 0, 1],
    fillRule: 'nonzero',
  },
  fill: red,
  stroke: null,
});
const docRect = (id: string, parent: string, effects: Effect[]) => ({
  ...base(id, parent, effects),
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: red,
  stroke: null,
});

function document(maskChildren = ['s', 'c']): DocumentV7 {
  const value = {
    schemaVersion: 7,
    id: 'd',
    pages: [{ id: 'p', name: 'P', children: ['g', 'm', 'f', 'h'] }],
    nodes: {
      g: { ...base('g', 'p', [DOC_SHADOW]), type: 'group', children: ['a'] },
      a: docRect('a', 'g', [DOC_BLUR]),
      m: { ...base('m', 'p', []), type: 'maskGroup', children: maskChildren },
      s: docPath('s', 'm', [DOC_SHADOW]),
      c: docPath('c', 'm', [DOC_SHADOW]),
      f: {
        ...base('f', 'p', [DOC_SHADOW]),
        type: 'frame',
        children: [],
        fill: red,
        stroke: null,
      },
      h: docRect('h', 'p', [{ ...DOC_SHADOW, visible: false }, DOC_BLUR]),
    },
  };
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

const noCustom = () => null;
const project = (doc: DocumentV7, effects: boolean, memo?: ProjectionMemo) =>
  projectPage(
    doc,
    doc.pages[0]!.id,
    noCustom,
    new Set(),
    memo,
    undefined,
    undefined,
    undefined,
    effects,
  );

const SCENE_SHADOW: SceneEffect = { ...SHADOW, offsetX: 2, offsetY: 4, sigma: 4 };
const SCENE_BLUR: SceneEffect = { kind: 'layerBlur', sigma: 1.5 };

describe('E41-S4 and S5 projector effects', () => {
  it('maps visible effects in order with sigma = radius / 2', () => {
    expect(
      sceneEffects([DOC_SHADOW, { ...DOC_BLUR, visible: false }, { ...DOC_SHADOW, radius: 0 }]),
    ).toEqual([SCENE_SHADOW, { ...SCENE_SHADOW, sigma: 0 }]);
    expect(sceneEffects([])).toEqual([]);
  });

  it('emits nothing without the option, so the scene is the pre-E41 value', () => {
    const projection = project(document(), false);
    for (const node of projection.nodes.values()) expect('effects' in node).toBe(false);
  });

  it('places effects on groups, leaves and a frame unit’s outer container', () => {
    const { nodes } = project(document(), true);
    expect(nodes.get('g')!.effects).toEqual([SCENE_SHADOW]);
    expect(nodes.get('a')!.effects).toEqual([SCENE_BLUR]);
    expect(nodes.get('f')!.effects).toEqual([SCENE_SHADOW]);
    expect('effects' in nodes.get(frameContentId('f'))!).toBe(false);
    // Only visible effects; none visible gives no key.
    expect(nodes.get('h')!.effects).toEqual([SCENE_BLUR]);
  });

  it('leaves out a mask source’s effects, and follows the source when it changes', () => {
    const memo: ProjectionMemo = new Map();
    const first = project(document(), true, memo);
    expect('effects' in first.nodes.get('s')!).toBe(false);
    expect(first.nodes.get('c')!.effects).toEqual([SCENE_SHADOW]);
    // Swap the mask group's children; the child node objects stay the same.
    const before = document();
    const swapped: DocumentV7 = {
      ...before,
      nodes: {
        ...before.nodes,
        m: { ...before.nodes.m!, children: ['c', 's'] } as DocumentV7['nodes'][string],
      },
    };
    const second = project(swapped, true, memo);
    expect(second.nodes.get('s')!.effects).toEqual([SCENE_SHADOW]);
    expect('effects' in second.nodes.get('c')!).toBe(false);
  });

  it('is accepted by a renderer on effects v0', () => {
    const renderer = new RecordingRenderer('supported', {
      groupOpacity: 'supported',
      effects: 'v0',
    });
    const editor = createEditor({ document: document(), projectEffects: true });
    editor.attachRenderer(renderer);
    expect(renderer.calls[0]!.result.status).toBe('applied');
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.getNode('g')!.effects).toEqual([SCENE_SHADOW]);
  });

  it('keeps effects out of the scene by default, so a renderer on none draws the content', () => {
    const renderer = new RecordingRenderer('supported', { groupOpacity: 'supported' });
    const editor = createEditor({ document: document() });
    editor.attachRenderer(renderer);
    expect(renderer.calls[0]!.result.status).toBe('applied');
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.getNode('g')).toBeDefined();
    for (const node of scene.nodes) expect('effects' in node).toBe(false);
  });
});

describe('E41-S10 an instance draws with its own effects, or else its source’s', () => {
  const symbols = (instance: Effect[], source: Effect[]): DocumentV7 => {
    const text = readFileSync(
      path.join(root, 'tests/fixtures/m4-appearance/migrated/symbols.v6.json'),
      'utf8',
    );
    const value = JSON.parse(v7Text(text)) as { nodes: Record<string, Record<string, unknown>> };
    value.nodes.s1!.effects = source;
    value.nodes.i1!.effects = instance;
    value.nodes['s1-r']!.effects = [DOC_BLUR];
    const result = validateDocument(value);
    if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
    return result.document;
  };

  it.each([
    ['none on either', [], [], undefined],
    ['the source’s when the instance has none', [], [DOC_SHADOW], [SCENE_SHADOW]],
    ['the instance’s when it has some', [DOC_BLUR], [DOC_SHADOW], [SCENE_BLUR]],
  ] as const)('draws %s', (_name, instance, source, expected) => {
    const { nodes } = project(symbols([...instance], [...source]), true);
    expect(nodes.get('i1')!.effects).toEqual(expected);
    expect(nodes.get('s1')!.effects).toEqual(source.length === 0 ? undefined : [SCENE_SHADOW]);
    // Expanded nodes carry the source tree's effects.
    expect(nodes.get(expandedId('i1', 's1-r'))!.effects).toEqual([SCENE_BLUR]);
  });
});
