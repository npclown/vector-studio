import type {
  RenderNodeSnapshot,
  SceneAffine,
  SceneClip,
  SceneColor,
  SceneEffect,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';

import {
  rebaseClipChain,
  type ClipChain,
  type ClipStateRecord,
} from '../../packages/renderer-core/src/clip-resolution.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U5c: E41-K2b in the source.
// Draws inside an effect root carry their chains rebased at the innermost root (no level above
// it, mask levels inside it planned apart), and the root's composite carries its ancestors'
// chain, rebased at the root around it (F6, F11, F12).

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const black: SceneColor = { r: 0, g: 0, b: 0, a: 0.5 };
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const shadow = (offsetX: number, offsetY: number, sigma: number): SceneEffect => ({
  kind: 'dropShadow',
  color: black,
  offsetX,
  offsetY,
  sigma,
});
const rect = (x: number, y: number, width: number, height: number): SceneClip => ({
  kind: 'rect',
  x,
  y,
  width,
  height,
});

const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};

function group(
  id: string,
  parentId: string | null,
  children: readonly string[],
  extra: Partial<{ effects: readonly SceneEffect[]; clip: SceneClip; opacity: number }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'container',
    clip: extra.clip ?? null,
    children,
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

function box(
  id: string,
  parentId: string | null,
  x: number,
  extra: Partial<{ effects: readonly SceneEffect[]; size: number }> = {},
): RenderNodeSnapshot {
  const size = extra.size ?? 40;
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
    style: { fill: red, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

function prepare(nodes: readonly RenderNodeSnapshot[]) {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'unsupported',
    clips: 'supported',
    groupOpacity: 'supported',
    effects: 'v0',
  });
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const result = mirror.replaceSnapshot({
    identity: { documentId: 'e41-u5c', pageId: 'page' },
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  });
  expect(result.status).toBe('applied');
  return new PrimitiveSceneSource(mirror).prepare({ ...target, offTargetEffectLayers: true })!;
}

function stateOf(packet: PrimitivePacket, index: number | undefined): ClipStateRecord | null {
  if (index === undefined) return null;
  return packet.clip!.states.find((state) => state.index === index)!;
}

/** Each state's rect widths and mask ids, for comparing chains by their content. */
function shape(record: ClipStateRecord | null) {
  return record === null
    ? null
    : { widths: record.rects.map((level) => level.width), masks: record.masks };
}

function layerOf(packet: PrimitivePacket, id: string) {
  const index = packet.layers!.layers.findIndex((layer) => layer.nodeId === id);
  expect(index).toBeGreaterThanOrEqual(0);
  return {
    layer: packet.layers!.layers[index]!,
    composite: packet.layers!.composites.find((composite) => composite.layer === index)!,
  };
}

describe('E41-K2b rebasing', () => {
  const level = (id: string, width: number) =>
    Object.freeze({
      kind: 'rect' as const,
      containerId: id,
      toLocal: IDENTITY,
      width,
      height: 1,
    });
  const mask = Object.freeze({
    kind: 'mask' as const,
    containerId: 'm',
    world: IDENTITY,
    sourceId: 's',
  });
  const bound = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const outer: ClipChain = Object.freeze({
    key: '5:frame;',
    levels: Object.freeze([level('frame', 1)]),
    bounds: Object.freeze([bound]),
    empty: false,
  });
  const chain: ClipChain = Object.freeze({
    key: '5:frame;1:m;1:c;',
    levels: Object.freeze([outer.levels[0]!, mask, level('c', 2)]),
    bounds: Object.freeze([bound, bound, bound]),
    empty: false,
  });

  it('drops the root’s ancestor levels and renames the mask levels left', () => {
    const rebased = rebaseClipChain(chain, outer, 'root')!;
    expect(rebased.levels.map((entry) => entry.containerId)).toEqual(['m', 'c']);
    expect(rebased.bounds).toHaveLength(2);
    expect(rebased.key).toBe('@4:root|1:m;1:c;');
    const renamed = rebased.levels[0]!;
    expect(renamed.kind === 'mask' && renamed.levelId).toBe('e41\u00004:root;m');
    // One object per chain and root; another root gets its own.
    expect(rebaseClipChain(chain, outer, 'root')).toBe(rebased);
    expect(rebaseClipChain(chain, outer, 'other')).not.toBe(rebased);
  });

  it('keeps a chain under an unclipped root, and leaves nothing for the root’s own chain', () => {
    expect(rebaseClipChain(chain, null, 'root')).toBe(chain);
    expect(rebaseClipChain(outer, outer, 'root')).toBeNull();
    expect(rebaseClipChain(null, outer, 'root')).toBeNull();
  });

  it('refuses a chain that does not extend the root’s', () => {
    const stranger: ClipChain = Object.freeze({ ...chain, key: '4:else;1:m;1:c;' });
    expect(() => rebaseClipChain(stranger, outer, 'root')).toThrow(/does not extend/);
  });
});

describe('E41-K2b in the packet', () => {
  it('F6: a shadowed child of a clipping frame draws unclipped in L; the composite clips', () => {
    const packet = prepare([
      group('frame', null, ['card'], { clip: rect(0, 0, 120, 100) }),
      box('card', 'frame', 100, { effects: [shadow(-50, 0, 2)] }),
    ]);
    const { layer, composite } = layerOf(packet, 'card');
    expect(layer.draws.map((draw) => draw.clipState ?? 0)).toEqual([0]);
    expect(shape(stateOf(packet, composite.clipState))).toEqual({ widths: [120], masks: [] });
    // L holds the card past the frame's edge, whose shadow falls inside it; R stops at the frame.
    expect(layer.effect!.source.x + layer.effect!.source.width).toBeGreaterThanOrEqual(140);
    expect(layer.effect!.output.x + layer.effect!.output.width).toBeLessThanOrEqual(122);
  });

  it('keeps a container root’s own clip in L and its ancestors’ at the composite', () => {
    const packet = prepare([
      group('frame', null, ['card'], { clip: rect(0, 0, 300, 200) }),
      group('card', 'frame', ['a'], { effects: [shadow(20, 0, 2)], clip: rect(10, 10, 50, 50) }),
      box('a', 'card', 0, { size: 100 }),
    ]);
    const { layer, composite } = layerOf(packet, 'card');
    expect(layer.draws).toHaveLength(1);
    expect(shape(stateOf(packet, layer.draws[0]!.clipState))).toEqual({
      widths: [50],
      masks: [],
    });
    expect(shape(stateOf(packet, composite.clipState))).toEqual({ widths: [300], masks: [] });
  });

  it('F11: a shadowed child of a mask group is masked once, at its composite', () => {
    const packet = prepare([
      group('m', null, ['s', 'card'], { clip: { kind: 'mask' } }),
      box('s', 'm', 0, { size: 200 }),
      box('card', 'm', 60, { effects: [shadow(30, 0, 2)] }),
    ]);
    const { layer, composite } = layerOf(packet, 'card');
    expect(layer.draws.map((draw) => draw.clipState ?? 0)).toEqual([0]);
    expect(shape(stateOf(packet, composite.clipState))).toEqual({ widths: [], masks: ['m'] });
    expect(packet.clip!.masks.map((level) => level.id)).toEqual(['m']);
  });

  it('F12: a mask group inside a root in a clipping frame plans its level apart', () => {
    const packet = prepare([
      group('frame', null, ['g'], { clip: rect(0, 0, 300, 200) }),
      group('g', 'frame', ['mg'], { effects: [shadow(20, 10, 3)] }),
      group('mg', 'g', ['s', 'c'], { clip: { kind: 'mask' } }),
      box('s', 'mg', 20, { size: 60 }),
      box('c', 'mg', 40, { size: 60 }),
    ]);
    const { layer, composite } = layerOf(packet, 'g');
    const rebasedId = 'e41\u00001:g;mg';
    expect(layer.draws).toHaveLength(1);
    // The content reads the rebased level: the frame's rect is not in it, nor in the state.
    expect(shape(stateOf(packet, layer.draws[0]!.clipState))).toEqual({
      widths: [],
      masks: [rebasedId],
    });
    const levels = packet.clip!.masks;
    expect(levels.map((entry) => entry.id)).toEqual([rebasedId]);
    expect(levels[0]).toMatchObject({ parent: null, rects: [] });
    expect(shape(stateOf(packet, composite.clipState))).toEqual({ widths: [300], masks: [] });
  });

  it('rebases a root inside a root at the outer root', () => {
    const packet = prepare([
      group('frame', null, ['outer'], { clip: rect(0, 0, 400, 300) }),
      group('outer', 'frame', ['inner-frame'], { effects: [shadow(10, 0, 2)] }),
      group('inner-frame', 'outer', ['card'], { clip: rect(0, 0, 200, 150) }),
      box('card', 'inner-frame', 60, { effects: [shadow(80, 0, 2)] }),
    ]);
    const outer = layerOf(packet, 'outer');
    const card = layerOf(packet, 'card');
    expect(card.layer.draws.map((draw) => draw.clipState ?? 0)).toEqual([0]);
    expect(card.composite.target).toBe(packet.layers!.layers.indexOf(outer.layer));
    expect(shape(stateOf(packet, card.composite.clipState))).toEqual({
      widths: [200],
      masks: [],
    });
    expect(shape(stateOf(packet, outer.composite.clipState))).toEqual({
      widths: [400],
      masks: [],
    });
  });

  it('keeps E25 layers’ composites unclipped and their content’s full chains', () => {
    const packet = prepare([
      group('frame', null, ['half'], { clip: rect(0, 0, 300, 200) }),
      group('half', 'frame', ['a'], { opacity: 0.5 }),
      box('a', 'half', 20),
    ]);
    const { layer, composite } = layerOf(packet, 'half');
    expect(composite.clipState).toBeUndefined();
    expect(shape(stateOf(packet, layer.draws[0]!.clipState))).toEqual({
      widths: [300],
      masks: [],
    });
  });

  it('leaves the chains of draws outside every effect root as they were', () => {
    const packet = prepare([
      group('frame', null, ['plain', 'card'], { clip: rect(0, 0, 120, 100) }),
      box('plain', 'frame', 0),
      box('card', 'frame', 60, { effects: [shadow(50, 0, 2)] }),
    ]);
    expect(shape(stateOf(packet, packet.draws[0]!.clipState))).toEqual({
      widths: [120],
      masks: [],
    });
    expect(layerOf(packet, 'card').composite.clipState).toBe(packet.draws[0]!.clipState);
  });
});
