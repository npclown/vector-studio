import type {
  RendererInvalidationTarget,
  RenderNodeSnapshot,
  SceneAffine,
  SceneColor,
} from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type {
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import {
  E28_ATLAS_PAGES_MAX,
  E28_ATLAS_PAGE_SIZE,
  E28_RASTER_PER_FRAME,
  TEXT_INSTANCE_FLOATS,
  getTextLocalBounds,
  isUniformScale,
  roundHalfUp,
  sizeBucket,
  snappedPlacement,
  textDeviceMap,
  textNoticeDiagnostic,
} from '../../packages/renderer-core/src/text-atlas.js';
import { FakeRaster, many, textNode, type TextOptions } from '../support/e28-text-harness.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), unit U2: the atlas plan, the
// `text` packet part and its ordering in renderer-core. E28-A02 (placement, keys, order, page
// splits, eviction, raster budget, commit on acknowledge, notices), the unit parts of E28-A04
// (raster and upload counts), E28-A06 (atlas bound) and E28-A08 (T9 generations with a fake port).

const identity = { documentId: 'e28-u2', pageId: 'page' } as const;
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };

function box(id: string, x: number, parentId: string | null = null): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: red, stroke: null },
  };
}

function group(
  id: string,
  children: readonly string[],
  opacity = 0.5,
  clip: Extract<RenderNodeSnapshot, { kind: 'container' }>['clip'] = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: IDENTITY,
    visible: true,
    opacity,
    kind: 'container',
    clip,
    children,
  };
}

function setup(
  nodes: readonly RenderNodeSnapshot[],
  options: Readonly<{ pages?: number; pageSize?: number; paths?: boolean }> = {},
) {
  const port = new FakeRaster();
  const reasons: string[] = [];
  const invalidation: RendererInvalidationTarget = {
    invalidate: ({ reason }) => {
      reasons.push(reason);
    },
    setMode: () => undefined,
  };
  const service = new PrimitiveRendererService(invalidation, {
    clips: 'all',
    groups: 'isolated',
    text: 'atlas',
    glyphRaster: port,
    ...(options.paths === true ? { fillMesh: createCountingPort() } : {}),
    ...(options.pages === undefined ? {} : { textAtlasPagesForTesting: options.pages }),
    ...(options.pageSize === undefined ? {} : { textAtlasPageSizeForTesting: options.pageSize }),
  });
  service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  let revision = 0;
  const replace = (next: readonly RenderNodeSnapshot[]) => {
    revision += 1;
    const result = service.replaceSnapshot({
      identity,
      revision,
      nodes: next,
      rootOrder: next.filter((node) => node.parentId === null).map((node) => node.id),
    });
    expect(result.status).toBe('applied');
  };
  replace(nodes);
  // The backend's pages: one incarnation per page index, kept while the page exists.
  const incarnations: symbol[] = [];
  const receipt = (packet: PrimitivePacket): PrimitiveReceipt => {
    const base = receiptOf(packet);
    const part = packet.text;
    if (part === undefined) return base;
    while (incarnations.length < part.pageCount) incarnations.push(Symbol('page'));
    incarnations.length = part.pageCount;
    return {
      ...base,
      text: { pages: [...incarnations], clears: part.clears.length, uploads: part.uploads.length },
    };
  };
  /** Prepares a frame and, unless `acknowledge` is false, acknowledges it. */
  const frame = (frameTarget: PrimitiveTarget = target, acknowledge = true): PrimitivePacket => {
    const packet = service.prepare(frameTarget)!;
    expect(packet).not.toBeNull();
    if (acknowledge) service.acknowledge(receipt(packet));
    return packet;
  };
  /** 'scene' invalidations raised by acknowledgements since the last call. */
  const takeInvalidations = () => reasons.splice(0).filter((reason) => reason === 'scene').length;
  return { service, port, replace, frame, receipt, incarnations, takeInvalidations };
}

/** The instance record `index` of a packet's text part. */
function instance(packet: PrimitivePacket, index: number): number[] {
  return [
    ...packet.text!.instances.subarray(
      index * TEXT_INSTANCE_FLOATS,
      (index + 1) * TEXT_INSTANCE_FLOATS,
    ),
  ];
}

function instanceCount(packet: PrimitivePacket): number {
  return (packet.text?.instances.length ?? 0) / TEXT_INSTANCE_FLOATS;
}

describe('E28-K1 to K3 placement', () => {
  it('buckets device sizes by 1/4 px to 64 px, then whole px, capped at C', () => {
    expect(sizeBucket(0.5)).toBe(0.5);
    expect(sizeBucket(10.1)).toBe(10);
    expect(sizeBucket(10.125)).toBe(10.25);
    expect(sizeBucket(64)).toBe(64);
    expect(sizeBucket(64.4)).toBe(64);
    expect(sizeBucket(64.5)).toBe(65);
    expect(sizeBucket(255.5)).toBe(256);
    expect(sizeBucket(300)).toBe(256);
  });

  it('rounds half up, negative values included, and picks the phase and pixel corner', () => {
    expect(roundHalfUp(-0.5)).toBe(0);
    expect(roundHalfUp(-0.51)).toBe(-1);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(snappedPlacement(15.3, 20.2)).toEqual({ phaseX: 0.25, px: 15, py: 20 });
    expect(snappedPlacement(15.5, 20.5)).toEqual({ phaseX: 0.5, px: 15, py: 21 });
    expect(snappedPlacement(-0.125, -0.5)).toEqual({ phaseX: 0, px: 0, py: 0 });
    expect(snappedPlacement(-0.13, -0.51)).toEqual({ phaseX: 0.75, px: -1, py: -1 });
    expect(snappedPlacement(-2.6, 0)).toEqual({ phaseX: 0.5, px: -3, py: 0 });
  });

  it('classifies uniform positive scales as snapped, anything else as general', () => {
    const camera = { position: { x: 10, y: -5 }, zoom: 2 };
    const map = textDeviceMap([1, 0, 0, 1, 30, 40], camera, 1.5);
    expect(map).toEqual([3, 0, 0, 3, 60, 135]);
    expect(isUniformScale(map, 3)).toBe(true);
    expect(isUniformScale([3, 1e-12, 0, 3, 0, 0], 3)).toBe(true);
    expect(isUniformScale([3, 1e-6, 0, 3, 0, 0], 3)).toBe(false);
    expect(isUniformScale([0, 1, -1, 0, 0, 0], 1)).toBe(false);
    expect(isUniformScale([-1, 0, 0, 1, 0, 0], 1)).toBe(false);
    expect(isUniformScale([1, 0, 0.5, 1, 0, 0], 1)).toBe(false);
    expect(isUniformScale([2, 0, 0, 1, 0, 0], Math.SQRT2)).toBe(false);
  });

  it('E28-K9: a node bound is the union of its cluster bounds', () => {
    const node = textNode('t', [
      ['a', 0],
      ['b', 30],
    ]) as Extract<RenderNodeSnapshot, { kind: 'text' }>;
    // Clusters at x 0 and 30, advance 8, baseline 20, size 16.
    expect(getTextLocalBounds(node)).toEqual({ minX: -16, minY: -12, maxX: 54, maxY: 36 });
    expect(getTextLocalBounds(textNode('e', []) as never)).toBeNull();
  });

  it('rejects a text node whose E28-K9 world bound is not finite', () => {
    const service = new PrimitiveRendererService(
      { invalidate: () => undefined, setMode: () => undefined },
      { clips: 'all', text: 'atlas', glyphRaster: new FakeRaster() },
    );
    const apply = (node: RenderNodeSnapshot) =>
      service.replaceSnapshot({ identity, revision: 1, nodes: [node], rootOrder: [node.id] });
    const node = textNode('t', [['A', 1e308]]) as Extract<RenderNodeSnapshot, { kind: 'text' }>;
    const run = node.runs[0]!;
    const overflow = { ...run, clusters: [{ ...run.clusters[0]!, advance: 1e308 }] };
    expect(apply({ ...node, runs: [overflow] })).toMatchObject({ reason: 'invalid-value' });
    expect(
      apply(textNode('t', [['A', 1e300]], { transform: [1e10, 0, 0, 1e10, 0, 0] })),
    ).toMatchObject({ reason: 'invalid-value' });
    expect(apply(textNode('t', [], { transform: [1e300, 0, 0, 1e300, 0, 0] }))).toMatchObject({
      status: 'applied',
    });
  });

  it('places a snapped cluster unscaled on whole pixels', () => {
    const { frame } = setup([textNode('t', [['A', 5.3]], { transform: [1, 0, 0, 1, 10, 0] })]);
    const packet = frame();
    const part = packet.text!;
    expect(part).toMatchObject({ layoutVersion: 0, pageSize: E28_ATLAS_PAGE_SIZE, pageCount: 1 });
    // Pen origin (15.3, 20): phase 0.25, P = (15, 20); bucket 16; bitmap 14 × 23, left 2, top 18.
    expect(part.uploads).toHaveLength(1);
    expect(part.uploads[0]).toMatchObject({ page: 0, x: 0, y: 0, width: 14, height: 23 });
    expect(instance(packet, 0)).toEqual([13, 2, 14, 0, 0, 23, 0, 0, 14, 23, 0, 0, 0, 0, 0, 1]);
    expect(part.draws).toEqual([
      { first: 0, count: 1, page: 0, target: -1, position: 0, order: 0 },
    ]);
  });

  it('places a general cluster by o + (size / b) · M_lin · (u − (left + phase, top))', () => {
    const { frame, port } = setup([
      textNode('t', [['A', 0]], { y: 0, transform: [0, 1, -1, 0, 100, 50] }),
    ]);
    const packet = frame();
    expect(port.requests).toEqual([
      { text: 'A', fontList: '"Arial", sans-serif', lang: 'ko', pixelSize: 16, phaseX: 0 },
    ]);
    // o = (100, 50); u0 = (−2, −18) maps to (118, 48); the x axis is (0, 14), the y axis (−23, 0).
    expect(instance(packet, 0)).toEqual([118, 48, 0, 14, -23, 0, 0, 0, 14, 23, 0, 1, 0, 0, 0, 1]);
  });

  it('magnifies the capped bitmap above C by the general path', () => {
    const { frame, port } = setup([textNode('t', [['A', 0]], { size: 512, y: 0 })]);
    const packet = frame();
    expect(port.requests[0]!.pixelSize).toBe(256);
    // k = 512 / 256 = 2: bitmap 158 × 311 spans 316 × 622 px.
    expect(instance(packet, 0).slice(0, 6)).toEqual([-4, -516, 316, 0, 0, 622]);
    expect(instance(packet, 0)[11]).toBe(1);
  });

  it('premultiplies the run colour by its alpha and the node opacity (E28-K5)', () => {
    const { frame } = setup([
      textNode('t', [['A', 0]], { color: { r: 1, g: 0.5, b: 0, a: 0.5 }, opacity: 0.5 }),
    ]);
    expect(instance(frame(), 0).slice(12)).toEqual([0.25, 0.125, 0, 0.25]);
  });

  it('draws nothing and calls no port for s < 0.5 or a cluster outside the target', () => {
    const { frame, port } = setup([
      textNode('small', [['A', 0]], { size: 0.4 }),
      textNode('far', [
        ['B', 2000],
        ['C', 10],
      ]),
    ]);
    const packet = frame();
    expect(port.requests.map((request) => request.text)).toEqual(['C']);
    expect(instanceCount(packet)).toBe(1);
  });
});

describe('E28-K10 keys and the raster port', () => {
  it('rasterizes one key once per frame and reuses it across frames', () => {
    const { frame, port, service } = setup([
      textNode('t', [
        ['A', 0],
        ['A', 8],
        ['A', 16],
      ]),
    ]);
    const first = frame();
    // x 0, 8 and 16 all have phase 0; one raster, three instances from one entry.
    expect(port.requests).toHaveLength(1);
    expect(instanceCount(first)).toBe(3);
    expect(first.text!.draws).toEqual([
      { first: 0, count: 3, page: 0, target: -1, position: 0, order: 0 },
    ]);
    frame();
    expect(port.requests).toHaveLength(1);
    expect(service.getGlyphRasterCallsForTesting()).toBe(1);
    expect(service.getGlyphUploadsForTesting()).toBe(1);
  });

  it('T9: a new layout generation never draws an earlier generation’s bitmap', () => {
    const { frame, port, replace } = setup([textNode('t', [['A', 0]], { generation: 1 })]);
    const first = frame();
    replace([textNode('t', [['A', 0]], { generation: 2 })]);
    const second = frame();
    expect(port.requests).toHaveLength(2);
    expect(second.text!.uploads).toHaveLength(1);
    expect(second.text!.uploads[0]!.coverage[0]).not.toBe(first.text!.uploads[0]!.coverage[0]);
    // The generation-2 instance reads the new entry, not the generation-1 one.
    expect(instance(second, 0).slice(6, 8)).toEqual([
      second.text!.uploads[0]!.x,
      second.text!.uploads[0]!.y,
    ]);
    expect(instance(second, 0).slice(6, 8)).not.toEqual(instance(first, 0).slice(6, 8));
  });

  it('keys by lang and font list too', () => {
    const { frame, port, replace } = setup([textNode('t', [['A', 0]])]);
    frame();
    const node = textNode('t', [['A', 0]]) as Extract<RenderNodeSnapshot, { kind: 'text' }>;
    replace([{ ...node, lang: 'ja' }]);
    frame();
    replace([{ ...node, runs: [{ ...node.runs[0]!, fontList: 'serif' }] }]);
    frame();
    expect(port.requests.map((request) => [request.lang, request.fontList])).toEqual([
      ['ko', '"Arial", sans-serif'],
      ['ja', '"Arial", sans-serif'],
      ['ko', 'serif'],
    ]);
  });

  it('E28-D3: failures and throws are reported once per node, reason and generation', () => {
    const { frame, port, replace, takeInvalidations } = setup([
      textNode('t', [
        ['FAIL', 0],
        ['BIG', 10],
        ['THROW', 20],
        [' ', 30],
        ['A', 40],
      ]),
    ]);
    takeInvalidations();
    const first = frame();
    expect(first.text!.notices).toEqual([
      { code: 'glyph-raster-failure', nodeId: 't', reason: 'unavailable' },
      { code: 'glyph-raster-failure', nodeId: 't', reason: 'too-large' },
      { code: 'glyph-raster-failure', nodeId: 't', reason: 'threw' },
    ]);
    expect(instanceCount(first)).toBe(1);
    // Failed and empty outcomes are kept: no second call, no second notice, no invalidation.
    const second = frame();
    expect(port.requests).toHaveLength(5);
    expect(second.text!.notices).toEqual([]);
    expect(takeInvalidations()).toBe(0);
    // A new generation reports again.
    replace([textNode('t', [['FAIL', 0]], { generation: 1 })]);
    expect(frame().text!.notices).toEqual([
      { code: 'glyph-raster-failure', nodeId: 't', reason: 'unavailable' },
    ]);
    // A bitmap over 1,024 px is too large; a malformed result counts as a throw.
    replace([
      textNode('u', [
        ['HUGE', 0],
        ['BAD', 10],
      ]),
    ]);
    expect(frame().text!.notices).toEqual([
      { code: 'glyph-raster-failure', nodeId: 'u', reason: 'too-large' },
      { code: 'glyph-raster-failure', nodeId: 'u', reason: 'threw' },
    ]);
    expect(
      textNoticeDiagnostic({ code: 'glyph-raster-failure', nodeId: 't', reason: 'threw' }, 3),
    ).toMatchObject({
      code: DIAGNOSTIC_CODES.GLYPH_RASTER_FAILURE,
      severity: 'warning',
      generation: 3,
      context: { nodeId: 't', reason: 'threw' },
    });
  });
});

describe('E28 section 4 order', () => {
  it('a text draw closes the analytic run at its paint position', () => {
    const { frame } = setup([box('a', 0), textNode('t', [['A', 0]]), box('b', 40)]);
    const packet = frame();
    expect(packet.draws.map((draw) => [draw.first, draw.count])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(packet.text!.draws).toEqual([
      { first: 0, count: 1, page: 0, target: -1, position: 1, order: 0 },
    ]);
  });

  it('orders text draws against mesh draws at one position', () => {
    const { frame } = setup(
      [pathNode('p', 0), textNode('t', [['A', 0]]), pathNode('q', 40), textNode('u', [['B', 0]])],
      { paths: true },
    );
    const packet = frame();
    expect(packet.draws).toEqual([]);
    expect(packet.mesh!.draws.map((draw) => draw.position)).toEqual([0, 0]);
    // Slots at position 0: p (mesh), t (order 1), q (mesh), u (order 3).
    expect(packet.text!.draws.map((draw) => [draw.position, draw.order])).toEqual([
      [0, 1],
      [0, 3],
    ]);
  });

  it('orders text against composites, and draws text in a layer in that layer', () => {
    const { frame } = setup([
      group('g', ['b', 'inner']),
      box('b', 0, 'g'),
      textNode('inner', [['A', 0]], { parentId: 'g' }),
      textNode('t', [['B', 0]]),
    ]);
    const packet = frame();
    // Main pass: g's composite (order 0), then t (order 1), both at position 0.
    expect(packet.layers!.composites).toEqual([{ layer: 0, target: -1, position: 0, order: 0 }]);
    expect(packet.text!.draws.map((draw) => [draw.target, draw.position, draw.order])).toEqual([
      [0, 1, 0],
      [-1, 0, 1],
    ]);
    // E28-K9: the layer bound covers the text bound.
    const bound = packet.layers!.layers[0]!.bound;
    // The text's [−16, 24] × [−12, 36] reaches past the box's [0, 10] × [20, 30].
    expect(bound.x + bound.width).toBeGreaterThanOrEqual(24);
    expect(bound.y).toBeLessThanOrEqual(0);
    expect(bound.y + bound.height).toBeGreaterThanOrEqual(36);
  });

  it('carries the clip state of a clipped text leaf (E28-K8)', () => {
    const { frame } = setup([
      group('g', ['t'], 1, { kind: 'rect', x: 0, y: 0, width: 300, height: 300 }),
      textNode('t', [['A', 0]], { parentId: 'g' }),
    ]);
    const packet = frame();
    expect(packet.text!.draws[0]!.clipState).toBeGreaterThan(0);
    expect(packet.clip!.states.length).toBeGreaterThan(0);
  });

  it('E28-S5: a scene without text has no text part and the same draws as text: none', () => {
    const nodes = [box('a', 0), group('g', ['b']), box('b', 20, 'g')];
    const { frame } = setup(nodes);
    const atlas = frame();
    const plain = new PrimitiveRendererService(
      { invalidate: () => undefined, setMode: () => undefined },
      { clips: 'all', groups: 'isolated' },
    );
    plain.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    plain.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: ['a', 'g'] });
    const none = plain.prepare(target)!;
    expect(atlas.text).toBeUndefined();
    expect(atlas.draws).toEqual(none.draws);
    expect(atlas.layers).toEqual(none.layers);
  });
});

describe('E28 section 4 pages and eviction', () => {
  // Size 4: bitmaps 6 × 9 px; a 16 px page holds two of them.
  const small = { size: 4 } as const;

  it('splits a leaf’s draws at a page change', () => {
    const { frame } = setup([textNode('t', many(3), small)], { pages: 2, pageSize: 16 });
    const packet = frame();
    expect(packet.text!.pageCount).toBe(2);
    expect(packet.text!.draws.map((draw) => [draw.first, draw.count, draw.page])).toEqual([
      [0, 2, 0],
      [2, 1, 1],
    ]);
    expect(packet.text!.uploads.map((upload) => [upload.page, upload.x, upload.y])).toEqual([
      [0, 0, 0],
      [0, 7, 0],
      [1, 0, 0],
    ]);
  });

  it('evicts the least recently used page not used by the frame, and clears it', () => {
    const { frame, replace, service } = setup([textNode('t', many(4), small)], {
      pages: 2,
      pageSize: 16,
    });
    frame();
    replace([textNode('t', many(2, 10), small)]);
    const second = frame();
    // Both pages are unused and equally old: the lower index goes.
    expect(second.text!.clears).toEqual([{ page: 0, x: 0, y: 0, width: 16, height: 16 }]);
    expect(second.text!.uploads.map((upload) => upload.page)).toEqual([0, 0]);
    expect(service.getAtlasEvictionsForTesting()).toBe(1);
    // The frame's own page is never evicted: the next miss evicts page 1.
    replace([textNode('t', [...many(2, 10), ...many(1, 20)], small)]);
    const third = frame();
    expect(third.text!.clears).toEqual([{ page: 1, x: 0, y: 0, width: 16, height: 16 }]);
    expect(service.getAtlasEvictionsForTesting()).toBe(2);
  });

  it('evicts the least recently used page when the frames that drew them differ', () => {
    const { frame, replace } = setup([textNode('t', many(4), small)], { pages: 2, pageSize: 16 });
    frame();
    // Draws page 1 only, so page 0 becomes the least recently used.
    replace([textNode('t', many(2, 2), small)]);
    frame();
    replace([textNode('t', many(1, 20), small)]);
    expect(frame().text!.clears.map((clear) => clear.page)).toEqual([0]);
  });

  it('evicts pages holding only older-generation entries first', () => {
    const { frame, replace } = setup([textNode('a', many(2), { ...small, generation: 1 })], {
      pages: 2,
      pageSize: 16,
    });
    frame();
    replace([textNode('b', many(2, 10), { ...small, generation: 0 })]);
    frame();
    // Page 0 (generation 1) is the least recently used, but page 1 holds only generation 0.
    replace([textNode('a', many(1, 20), { ...small, generation: 1 })]);
    const third = frame();
    expect(third.text!.clears.map((clear) => clear.page)).toEqual([1]);
  });

  it('omits what does not fit and reports E28-D2 once per transition', () => {
    const { frame, replace } = setup([textNode('t', many(3), small)], { pages: 1, pageSize: 16 });
    const first = frame();
    expect(instanceCount(first)).toBe(2);
    expect(first.text!.notices).toEqual([
      { code: 'text-resource-limit', nodeId: 't', omitted: 1, pages: 1 },
    ]);
    expect(frame().text!.notices).toEqual([]);
    replace([textNode('t', many(2), small)]);
    expect(frame().text!.notices).toEqual([]);
    replace([textNode('t', many(3), small)]);
    expect(frame().text!.notices).toEqual([
      { code: 'text-resource-limit', nodeId: 't', omitted: 1, pages: 1 },
    ]);
    expect(
      textNoticeDiagnostic({ code: 'text-resource-limit', nodeId: 't', omitted: 1, pages: 1 }, 2),
    ).toMatchObject({ code: DIAGNOSTIC_CODES.TEXT_RESOURCE_LIMIT, generation: 2 });
  });

  it('E28-A06: the atlas never exceeds 8 pages of 2048², 32 MiB', () => {
    expect(E28_ATLAS_PAGES_MAX * E28_ATLAS_PAGE_SIZE ** 2).toBe(32 * 1024 * 1024);
    // Size 600 caps at 256: bitmaps 158 × 311; a page holds 12 × 6 = 72 of them.
    const { frame } = setup([textNode('t', many(700), { size: 600 })], { pages: 8 });
    let packet = frame();
    for (let index = 0; index < 4; index += 1) {
      expect(packet.text!.pageCount).toBeLessThanOrEqual(E28_ATLAS_PAGES_MAX);
      packet = frame();
    }
    expect(packet.text!.pageCount).toBe(E28_ATLAS_PAGES_MAX);
    expect(instanceCount(packet)).toBe(8 * 72);
  });
});

describe('E28 section 4 over the atlas limit', () => {
  const small = { size: 4 } as const;

  it('converges: an over-limit frame omits the rest without port calls and defers nothing', () => {
    const { frame, service, takeInvalidations } = setup([textNode('t', many(300), small)], {
      pages: 1,
      pageSize: 16,
    });
    takeInvalidations();
    const first = frame();
    // Two bitmaps fit; the third finds every page used by this frame, and the rest are omitted.
    expect(service.getGlyphRasterCallsForTesting()).toBe(3);
    expect(instanceCount(first)).toBe(2);
    expect(first.text!.notices).toEqual([
      { code: 'text-resource-limit', nodeId: 't', omitted: 298, pages: 1 },
    ]);
    expect(takeInvalidations()).toBe(0);
    frame();
    frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(5);
    expect(takeInvalidations()).toBe(0);
  });

  it('rasterizes an omitted key once per frame', () => {
    const { frame, port } = setup(
      [
        textNode(
          't',
          [
            ...many(2),
            [String.fromCodePoint(0x5000), 20],
            [String.fromCodePoint(0x5000), 21],
            [String.fromCodePoint(0x5000), 22],
          ],
          small,
        ),
      ],
      { pages: 1, pageSize: 16 },
    );
    frame();
    expect(port.requests).toHaveLength(3);
  });
});

describe('E28 section 4 raster budget', () => {
  it('defers clusters past the budget, invalidates once per acknowledged packet and converges', () => {
    const { frame, service, takeInvalidations } = setup([textNode('t', many(300), { size: 4 })]);
    takeInvalidations();
    const first = frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(E28_RASTER_PER_FRAME);
    expect(instanceCount(first)).toBe(E28_RASTER_PER_FRAME);
    expect(takeInvalidations()).toBe(1);
    const second = frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(300);
    expect(instanceCount(second)).toBe(300);
    expect(takeInvalidations()).toBe(0);
  });

  it('draws a deferred cluster from the nearest bucket by the general path', () => {
    const { frame, service, takeInvalidations } = setup([textNode('t', many(300), { size: 4 })]);
    frame();
    frame();
    service.setCamera({ position: { x: 0, y: 0 }, zoom: 2 });
    takeInvalidations();
    const zoomed = frame();
    // 256 new rasters at bucket 8; the other 44 fall back to bucket 4, scaled by 2.
    expect(service.getGlyphRasterCallsForTesting()).toBe(300 + 256);
    expect(instanceCount(zoomed)).toBe(300);
    const modes = Array.from({ length: 300 }, (_, index) => instance(zoomed, index)[11]);
    expect(modes.filter((mode) => mode === 1)).toHaveLength(44);
    expect(instance(zoomed, 299).slice(2, 6)).toEqual([12, 0, 0, 18]);
    expect(takeInvalidations()).toBe(1);
    frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(600);
    expect(takeInvalidations()).toBe(0);
  });

  it('keeps the text part for a frame whose only text is deferred, so it is drawn later', () => {
    const empties: [string, number][] = Array.from({ length: E28_RASTER_PER_FRAME }, (_, index) => [
      `~${index}`,
      index,
    ]);
    const { frame, takeInvalidations } = setup([textNode('t', [...empties, ['A', 300]])]);
    takeInvalidations();
    const first = frame();
    expect(first.text).toMatchObject({ draws: [], pageCount: 0 });
    expect(takeInvalidations()).toBe(1);
    expect(instanceCount(frame())).toBe(1);
  });

  it('defers nothing for omitted or failed clusters', () => {
    const { frame, takeInvalidations } = setup(
      [
        textNode('t', [...many(3, 0), ['FAIL', 30]], {
          size: 4,
        }),
      ],
      { pages: 1, pageSize: 16 },
    );
    takeInvalidations();
    frame();
    expect(takeInvalidations()).toBe(0);
  });
});

describe('E28 section 4 lifetime', () => {
  it('commits only on acknowledge: an unacknowledged packet’s pages are planned again', () => {
    const { frame, replace, service, port } = setup([textNode('t', [['A', 0]])]);
    frame();
    replace([
      textNode('t', [
        ['A', 0],
        ['B', 20],
      ]),
    ]);
    // Not acknowledged (not-ready, stale-generation or failed).
    const lost = frame(target, false);
    expect(lost.text!.uploads).toHaveLength(1);
    // The replaced packet uploaded to page 0, so page 0's entries are dropped and it is cleared.
    const next = frame();
    expect(next.text!.clears).toEqual([{ page: 0, x: 0, y: 0, width: 2048, height: 2048 }]);
    expect(next.text!.uploads).toHaveLength(2);
    expect(port.requests.map((request) => request.text)).toEqual(['A', 'B', 'A', 'B']);
    expect(service.getGlyphUploadsForTesting()).toBe(3);
  });

  it('refuses a receipt without its text part', () => {
    const { service, receipt } = setup([textNode('t', [['A', 0]])]);
    const packet = service.prepare(target)!;
    const withoutText: PrimitiveReceipt = { ...receipt(packet) };
    delete (withoutText as { text?: unknown }).text;
    service.acknowledge(withoutText);
    expect(service.getGlyphUploadsForTesting()).toBe(0);
    service.acknowledge({ ...receipt(packet), text: { pages: [], clears: 0, uploads: 1 } });
    expect(service.getGlyphUploadsForTesting()).toBe(0);
    service.acknowledge(receipt(packet));
    expect(service.getGlyphUploadsForTesting()).toBe(1);
  });

  it('drops entries on a page whose incarnation changed, and redraws', () => {
    const { frame, port, incarnations, takeInvalidations } = setup([textNode('t', [['A', 0]])]);
    frame();
    incarnations[0] = Symbol('recreated');
    takeInvalidations();
    frame();
    expect(takeInvalidations()).toBe(1);
    frame();
    expect(port.requests).toHaveLength(2);
  });

  it('starts a new renderer generation from an empty plan', () => {
    const { frame, port } = setup([textNode('t', [['A', 0]])]);
    frame();
    const next = frame({ ...target, generation: 2 });
    expect(port.requests).toHaveLength(2);
    expect(next.text!.clears).toEqual([]);
    expect(next.text!.uploads).toHaveLength(1);
  });

  it('keeps pages for culled text and releases them when the last text node goes', () => {
    const { frame, replace, service } = setup([textNode('t', [['A', 0]]), box('b', 0)]);
    frame();
    service.setCamera({ position: { x: 5000, y: 0 }, zoom: 1 });
    const culled = frame();
    expect(culled.text).toMatchObject({ pageCount: 1, draws: [] });
    replace([box('b', 0)]);
    const released = frame();
    expect(released.text).toMatchObject({ pageCount: 0, draws: [], uploads: [] });
    expect(frame().text).toBeUndefined();
  });
});

describe('E28-A04 invalidation costs', () => {
  const nodes = (options: TextOptions = {}) => [
    textNode(
      't',
      [
        ['A', 0],
        ['B', 10],
        ['C', 20.4],
      ],
      options,
    ),
  ];

  it('colour, opacity and whole-pixel pans cost no raster and no upload', () => {
    const { frame, replace, service } = setup(nodes());
    frame();
    const calls = service.getGlyphRasterCallsForTesting();
    const uploads = service.getGlyphUploadsForTesting();
    replace(nodes({ color: red }));
    frame();
    replace(nodes({ color: red, opacity: 0.5 }));
    frame();
    service.setCamera({ position: { x: 3, y: -7 }, zoom: 1 });
    frame();
    // Out of view and back.
    service.setCamera({ position: { x: 5000, y: 0 }, zoom: 1 });
    frame();
    service.setCamera({ position: { x: 3, y: -7 }, zoom: 1 });
    frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(calls);
    expect(service.getGlyphUploadsForTesting()).toBe(uploads);
  });

  it('a sub-pixel pan costs at most one raster per key and new phase', () => {
    const { frame, service } = setup(nodes());
    frame();
    service.setCamera({ position: { x: 0.25, y: 0 }, zoom: 1 });
    frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(6);
    service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(6);
  });

  it('a zoom rasterizes only new buckets; a generation change re-rasterizes every visible cluster', () => {
    const { frame, replace, service, port } = setup(nodes());
    frame();
    service.setCamera({ position: { x: 0, y: 0 }, zoom: 2 });
    frame();
    expect(port.requests.slice(3).map((request) => request.pixelSize)).toEqual([32, 32, 32]);
    service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    frame();
    expect(port.requests).toHaveLength(6);
    replace(nodes({ generation: 1 }));
    frame();
    expect(port.requests).toHaveLength(9);
  });
});

describe('E28 test options', () => {
  it('rejects bad atlas test options with TypeError', () => {
    const port = new FakeRaster();
    const invalidation = { invalidate: () => undefined, setMode: () => undefined };
    const make = (options: object) => () =>
      new PrimitiveRendererService(invalidation, {
        clips: 'all',
        text: 'atlas',
        glyphRaster: port,
        ...options,
      });
    expect(make({ textAtlasPagesForTesting: 0 })).toThrow(TypeError);
    expect(make({ textAtlasPagesForTesting: 9 })).toThrow(TypeError);
    expect(make({ textAtlasPageSizeForTesting: 8 })).toThrow(TypeError);
    expect(make({ textAtlasPageSizeForTesting: 4096 })).toThrow(TypeError);
    expect(make({ textAtlasPagesForTesting: 1, textAtlasPageSizeForTesting: 16 })).not.toThrow();
    expect(
      () =>
        new PrimitiveRendererService(invalidation, { clips: 'all', textAtlasPagesForTesting: 2 }),
    ).toThrow(TypeError);
  });
});
