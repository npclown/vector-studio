import type {
  ImageSourcePort,
  ImageSourceResult,
  RenderNodeSnapshot,
  SceneAffine,
  SceneImagePaint,
} from '@vector-studio/contracts';
import { SCENE_MAX_IMAGE_KEY } from '@vector-studio/contracts';
import {
  ImageResidency,
  PrimitiveRendererService,
  buildImageMips,
  imageMipBytes,
  type ImagePaintRecord,
} from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import { buildGradientRecord } from '../../packages/renderer-core/src/paint-records.js';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';
import {
  ImageTextureStore,
  mipChainBytes,
  type ImageNotice,
} from '../../packages/renderer-webgpu/src/image-textures.js';
import { packGradientRecord } from '../../packages/renderer-webgpu/src/paint-pipeline.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';
import {
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U3: image paints through scene
// validation (V32-S1 to S3), the CPU mip chain and premultiply (V32-K4), the texture budget
// (V32-K5), the image record layout (V32-K8) and the per-draw image binding of the native scene
// (V32-K7), with the pending, failed and refused notices (V32-K3). Fake device seams only; the
// rendered evidence is the headed run.

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const red = { r: 1, g: 0, b: 0, a: 1 } as const;
const image = (key: string, fields: Record<string, unknown> = {}): SceneImagePaint => ({
  kind: 'image',
  image: key,
  transform: [10, 0, 0, 10, 0, 0],
  wrapX: 'extend',
  wrapY: 'extend',
  ...fields,
});

function box(id: string, x: number, fill: unknown, stroke: unknown = null): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill, stroke },
  } as RenderNodeSnapshot;
}

const IMAGES: RetainedSceneMirrorOptions = {
  pathNodes: 'supported',
  pathStrokes: 'supported',
  paints: 'image',
};

function replace(
  nodes: readonly RenderNodeSnapshot[],
  options: RetainedSceneMirrorOptions = IMAGES,
): string {
  const result = new RetainedSceneMirror(undefined, options).replaceSnapshot({
    identity: { documentId: 'v32-u3', pageId: 'page' },
    revision: 1,
    nodes,
    rootOrder: nodes.map((node) => node.id),
  });
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

describe('V32-S1 to S3 image paint validation', () => {
  it('accepts an image fill under paints image, beside solid and gradient fills', () => {
    expect(replace([box('a', 0, image('k1'))])).toBe('applied');
    for (const wrap of ['extend', 'decal', 'repeat']) {
      expect(replace([box('a', 0, image('k1', { wrapX: wrap, wrapY: wrap }))])).toBe('applied');
    }
    expect(replace([box('a', 0, image('x'.repeat(SCENE_MAX_IMAGE_KEY)))])).toBe('applied');
    expect(replace([box('a', 0, red), box('b', 20, image('k1'))])).toBe('applied');
  });

  it('is unsupported-feature under paints solid or gradient', () => {
    const solid = { pathNodes: 'supported', pathStrokes: 'supported' } as const;
    expect(replace([box('a', 0, image('k1'))], solid)).toBe('unsupported-feature');
    expect(replace([box('a', 0, image('k1'))], { ...solid, paints: 'gradient' })).toBe(
      'unsupported-feature',
    );
  });

  it('is invalid-value in a stroke slot, primitive or path', () => {
    expect(replace([box('a', 0, red, { color: image('k1'), width: 2 })])).toBe('invalid-value');
    const stroked = strokedNode('p', 0, {
      stroke: { color: image('k1') as never, width: 2, cap: 'butt', join: 'miter', miterLimit: 4 },
    }) as RenderNodeSnapshot;
    expect(replace([stroked])).toBe('invalid-value');
  });

  it('refuses each malformed field as invalid-value', () => {
    const cases: readonly Record<string, unknown>[] = [
      { image: '' },
      { image: 'x'.repeat(SCENE_MAX_IMAGE_KEY + 1) },
      { image: 'tab\there' },
      { image: 'é' },
      { image: 7 },
      { wrapX: 'clamp' },
      { wrapY: 'mirror' },
      { transform: [1, 2, 2, 4, 0, 0] },
      { transform: [1, 0, 0, 1, 0, Number.NaN] },
      { transform: [1, 0, 0, 1, 0] },
      { extra: true },
    ];
    for (const fields of cases) {
      expect(replace([box('a', 0, image('k1', fields))]), JSON.stringify(fields)).toBe(
        'invalid-value',
      );
    }
    const missing = { kind: 'image', image: 'k1', transform: [1, 0, 0, 1, 0, 0], wrapX: 'extend' };
    expect(replace([box('a', 0, missing)])).toBe('invalid-value');
  });
});

describe('V32-K4 premultiplied mip chain', () => {
  it('premultiplies level 0 in binary64 and rounds to 8 bits', () => {
    const pixels = new Uint8Array([255, 128, 0, 128, 10, 20, 30, 0, 200, 100, 50, 255]);
    const levels = buildImageMips(3, 1, pixels)!;
    expect([...levels[0]!.pixels]).toEqual([128, 64, 0, 128, 0, 0, 0, 0, 200, 100, 50, 255]);
    // The input is left as it was.
    expect(pixels[0]).toBe(255);
  });

  it('halves with floor sizes down to 1 × 1, clamping the odd last row and column', () => {
    const width = 5;
    const height = 3;
    const pixels = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      pixels.set([index * 10, 0, 0, 255], index * 4);
    }
    const levels = buildImageMips(width, height, pixels)!;
    expect(levels.map((level) => [level.width, level.height])).toEqual([
      [5, 3],
      [2, 1],
      [1, 1],
    ]);
    // Level 1 texel (1, 0) averages texels (2, 0), (3, 0), (2, 1), (3, 1): 20, 30, 70, 80.
    expect([...levels[1]!.pixels]).toEqual([30, 0, 0, 255, 50, 0, 0, 255]);
    expect([...levels[2]!.pixels]).toEqual([40, 0, 0, 255]);
    expect(imageMipBytes(levels)).toBe(mipChainBytes(width, height));
  });

  it('the mip byte count matches the chain for square, tall and 1-pixel images', () => {
    for (const [width, height] of [
      [1, 1],
      [4, 4],
      [1, 9],
      [300, 7],
    ] as const) {
      const levels = buildImageMips(width, height, new Uint8Array(width * height * 4))!;
      expect(imageMipBytes(levels), `${width}x${height}`).toBe(mipChainBytes(width, height));
    }
  });

  it('refuses a wrong size or buffer length', () => {
    expect(buildImageMips(0, 1, new Uint8Array(0))).toBeNull();
    expect(buildImageMips(1.5, 1, new Uint8Array(4))).toBeNull();
    expect(buildImageMips(4097, 1, new Uint8Array(4097 * 4))).toBeNull();
    expect(buildImageMips(2, 2, new Uint8Array(15))).toBeNull();
    expect(buildImageMips(1, 1, [0, 0, 0, 0] as unknown as Uint8Array)).toBeNull();
  });
});

describe('V32-K5 texture budget', () => {
  it('admits within the budget and releases the least recently drawn first', () => {
    const residency = new ImageResidency(100);
    expect(residency.admit('a', 40, 1)).toEqual({ admitted: true, release: [] });
    expect(residency.admit('b', 40, 1)).toEqual({ admitted: true, release: [] });
    residency.use('a', 2);
    expect(residency.admit('c', 40, 2)).toEqual({ admitted: true, release: ['b'] });
    expect(residency.keys()).toEqual(['a', 'c']);
    expect(residency.bytes).toBe(80);
  });

  it('never releases a texture drawn in the current frame, and refuses without releasing', () => {
    const residency = new ImageResidency(100);
    residency.admit('a', 40, 3);
    residency.admit('b', 40, 3);
    expect(residency.admit('c', 40, 3)).toEqual({ admitted: false, release: [] });
    expect(residency.keys()).toEqual(['a', 'b']);
    expect(residency.admit('huge', 101, 4)).toEqual({ admitted: false, release: [] });
    expect(residency.bytes).toBe(80);
    expect(residency.admit('c', 100, 4)).toEqual({ admitted: true, release: ['a', 'b'] });
    expect(residency.bytes).toBe(100);
  });

  it('a re-admitted key replaces its own entry', () => {
    const residency = new ImageResidency(100);
    residency.admit('a', 60, 1);
    expect(residency.admit('a', 70, 2)).toEqual({ admitted: true, release: [] });
    expect(residency.bytes).toBe(70);
    residency.remove('a');
    residency.remove('a');
    expect(residency.bytes).toBe(0);
  });
});

describe('V32-K8 image records', () => {
  it('maps device space to image space as a gradient does, and keeps the wraps and key', () => {
    const record = buildGradientRecord(
      image('k1', { wrapX: 'repeat', wrapY: 'decal', transform: [20, 0, 0, 10, 5, 0] }),
      [1, 0, 0, 1, 10, 20],
      { x: 0, y: 0 },
    ) as ImagePaintRecord;
    expect({ ...record, map: record.map.map((lane) => lane + 0) }).toEqual({
      kind: 'image',
      wrapX: 'repeat',
      wrapY: 'decal',
      image: 'k1',
      map: [0.05, 0, 0, 0.1, -0.75, -2].map(Math.fround),
    });
  });

  it('packs the header, map and texture size in one 368-byte record', () => {
    const record: ImagePaintRecord = {
      kind: 'image',
      wrapX: 'decal',
      wrapY: 'repeat',
      map: [0.5, 0, 0, 0.25, 1, 2],
      image: 'k1',
    };
    const bytes = packGradientRecord(record, { width: 64, height: 32, levels: 7 })!;
    expect(bytes.byteLength).toBe(368);
    const view = new DataView(bytes.buffer);
    expect([0, 4, 8, 12].map((offset) => view.getUint32(offset, true))).toEqual([2, 1, 7, 2]);
    expect([16, 20, 24, 28, 32, 36].map((offset) => view.getFloat32(offset, true))).toEqual([
      0.5, 0, 0, 0.25, 1, 2,
    ]);
    expect([48, 52, 56].map((offset) => view.getFloat32(offset, true))).toEqual([64, 32, 7]);
    // Without a texture the record names the transparent 1 × 1 texture.
    const fallback = new DataView(packGradientRecord(record)!.buffer);
    expect(
      [8, 48, 52, 56].map((offset, lane) =>
        lane === 0 ? fallback.getUint32(offset, true) : fallback.getFloat32(offset, true),
      ),
    ).toEqual([1, 1, 1, 1]);
  });

  it('refuses an unknown wrap or a map lane outside binary32', () => {
    const good: ImagePaintRecord = {
      kind: 'image',
      wrapX: 'extend',
      wrapY: 'extend',
      map: [1, 0, 0, 1, 0, 0],
      image: 'k1',
    };
    expect(packGradientRecord({ ...good, wrapX: 'clamp' } as unknown as ImagePaintRecord)).toBe(
      null,
    );
    expect(packGradientRecord({ ...good, map: [1, 0, 0, 1, 0.1, 0] })).toBeNull();
    expect(packGradientRecord({ ...good, map: [1, 0, 0, 1, 0] })).toBeNull();
  });
});

type Script = Map<string, ImageSourceResult | 'throw'>;

function scriptedPort(script: Script) {
  const requests: string[] = [];
  const listeners = new Set<(keys: readonly string[]) => void>();
  const port: ImageSourcePort = {
    portVersion: 0,
    operationId: 'v32-u3/scripted',
    request(key) {
      requests.push(key);
      const result = script.get(key) ?? { status: 'failed', reason: 'unknown-image' };
      if (result === 'throw') throw new Error('scripted throw');
      return result;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const notify = (keys: readonly string[]) => {
    for (const listener of listeners) listener(keys);
  };
  return { port, requests, notify, listeners };
}

function ready(width: number, height: number): ImageSourceResult {
  return { status: 'ready', width, height, pixels: new Uint8Array(width * height * 4).fill(255) };
}

async function imageScene(script: Script, clips: 'rect' | 'supported' = 'rect') {
  const fixture = nativeFixture();
  const { port, requests, notify, listeners } = scriptedPort(script);
  const created = await nativeScene(fixture, {
    meshPipeline: true,
    clipPipeline: true,
    paintPipeline: true,
    imageSource: port,
  });
  const { creation, target } = created;
  const scene = created.scene as typeof created.scene &
    Readonly<{
      imageTextureStatsForTesting: Readonly<{ uploads: number; residentBytes: number }>;
      takeImageNotices(limit?: number): readonly ImageNotice[];
    }>;
  const run = (nodes: readonly RenderNodeSnapshot[]) => {
    const h = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: new ScriptedStrokeMeshPort(),
      clips,
      paints: 'image',
      nodes,
    });
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    return fixture.calls
      .filter((call) => call[0] === 'setBindGroup' && call[1] === 2)
      .map((call) => call[2]);
  };
  return { fixture, scene, creation, run, requests, notify, listeners };
}

describe('V32-K7 per-draw image binding', () => {
  const primitiveGroup = 'primitive/1/paint-primitives-2/bind-group';

  it('binds each image run with its own texture, uploading each image once', async () => {
    const { fixture, scene, creation, run, requests } = await imageScene(
      new Map([
        ['k1', ready(4, 2)],
        ['k2', ready(1, 1)],
      ]),
    );
    const groups = run([
      box('a', 0, image('k1')),
      box('b', 20, image('k2')),
      box('c', 40, image('k1')),
    ]);
    expect(groups).toEqual([
      `${primitiveGroup}+image`,
      `${primitiveGroup}+image`,
      `${primitiveGroup}+image`,
    ]);
    const uploads = fixture.textureWrites.filter(
      (write) => write.label.includes('/image-') && !write.label.includes('transparent'),
    );
    // k1: 4 × 2, 2 × 1, 1 × 1; k2: 1 × 1.
    expect(uploads.map((write) => [write.width, write.height])).toEqual([
      [4, 2],
      [2, 1],
      [1, 1],
      [1, 1],
    ]);
    expect(requests).toEqual(['k1', 'k2']);
    expect(scene.imageTextureStatsForTesting).toEqual({
      uploads: 2,
      residentBytes: mipChainBytes(4, 2) + mipChainBytes(1, 1),
    });
    // A second frame requests nothing and uploads nothing.
    run([box('a', 0, image('k1')), box('b', 20, image('k2'))]);
    expect(requests).toEqual(['k1', 'k2']);
    expect(scene.imageTextureStatsForTesting.uploads).toBe(2);
    expect(scene.takeImageNotices()).toEqual([]);
    creation.dispose();
  });

  it('a mesh draw binds the texture of its own fill record', async () => {
    const { fixture, creation, run, requests } = await imageScene(new Map([['k1', ready(2, 2)]]));
    const groups = run([
      box('a', 0, red),
      strokedNode('p', 40, { fill: image('k1') as never, stroke: null }),
    ]);
    expect(groups).toEqual(['primitive/1/paint-meshes-3/bind-group+image']);
    expect(requests).toEqual(['k1']);
    expect(fixture.textureWrites.filter((write) => write.label.endsWith('image-0'))).toHaveLength(
      2,
    );
    creation.dispose();
  });

  it('a pending image binds the transparent texture and is asked again only after a notification', async () => {
    const script: Script = new Map([['k1', { status: 'pending' }]]);
    const { scene, creation, run, requests, notify, listeners } = await imageScene(script);
    expect(run([box('a', 0, image('k1'))])).toEqual([primitiveGroup]);
    expect(scene.takeImageNotices()).toEqual([]);
    // V32-A05: no further request while nothing changed, frame after frame.
    run([box('a', 0, image('k1'))]);
    run([box('a', 0, image('k1'))]);
    expect(requests).toEqual(['k1']);
    script.set('k1', ready(2, 2));
    notify(['k1']);
    expect(run([box('a', 0, image('k1'))])).toEqual([`${primitiveGroup}+image`]);
    expect(requests).toEqual(['k1', 'k1']);
    creation.dispose();
    expect(listeners.size).toBe(0);
  });

  it('a failed, throwing or malformed image is reported once and asked again only after a notification', async () => {
    const script = new Map<string, ImageSourceResult | 'throw'>([
      ['bad', { status: 'failed', reason: 'decode-failed' }],
      ['boom', 'throw'],
      ['short', { status: 'ready', width: 2, height: 2, pixels: new Uint8Array(15) }],
      ['huge', { status: 'ready', width: 4097, height: 1, pixels: new Uint8Array(4097 * 4) }],
    ]);
    const { scene, creation, run, requests, notify } = await imageScene(script);
    const nodes = [
      box('a', 0, image('bad')),
      box('b', 20, image('boom')),
      box('c', 40, image('short')),
      box('d', 60, image('gone')),
      box('e', 80, image('huge')),
    ];
    expect(run(nodes)).toEqual([primitiveGroup]);
    expect(scene.takeImageNotices()).toEqual([
      { key: 'bad', kind: 'unavailable', reason: 'decode-failed' },
      { key: 'boom', kind: 'unavailable', reason: 'decode-failed' },
      { key: 'short', kind: 'unavailable', reason: 'decode-failed' },
      { key: 'gone', kind: 'unavailable', reason: 'unknown-image' },
      { key: 'huge', kind: 'unavailable', reason: 'too-large' },
    ]);
    run(nodes);
    expect(scene.takeImageNotices()).toEqual([]);
    expect(requests).toEqual(['bad', 'boom', 'short', 'gone', 'huge']);
    // A notification retries the key; it is drawn once ready, and not reported again.
    script.set('bad', ready(1, 1));
    notify(['bad', 'gone']);
    run(nodes);
    expect(requests).toEqual(['bad', 'boom', 'short', 'gone', 'huge', 'bad', 'gone']);
    expect(scene.takeImageNotices()).toEqual([]);
    expect(scene.imageTextureStatsForTesting.uploads).toBe(1);
    creation.dispose();
  });

  it('keeps notices past the per-frame limit for the next call', async () => {
    const { scene, creation, run } = await imageScene(new Map());
    run(Array.from({ length: 5 }, (_, index) => box(`n${index}`, index * 20, image(`k${index}`))));
    expect(scene.takeImageNotices(3).map((notice) => notice.key)).toEqual(['k0', 'k1', 'k2']);
    expect(scene.takeImageNotices(3).map((notice) => notice.key)).toEqual(['k3', 'k4']);
    creation.dispose();
  });

  it('never requests the image of a mask source (V32-S2)', async () => {
    const { creation, run, requests } = await imageScene(
      new Map([
        ['k1', ready(2, 2)],
        ['k2', ready(2, 2)],
      ]),
      'supported',
    );
    const mask = {
      id: 'm',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      clip: { kind: 'mask' },
      children: ['source', 'content'],
    } as RenderNodeSnapshot;
    run([
      mask,
      { ...box('source', 0, image('k1')), parentId: 'm' },
      { ...box('content', 0, image('k2')), parentId: 'm' },
    ]);
    // The content's image is requested, so the scene did draw image paints; the source's is not.
    expect(requests).toEqual(['k2']);
    creation.dispose();
  });

  it('a solid scene creates no image textures or samplers', async () => {
    const { fixture, creation, run } = await imageScene(new Map());
    expect(run([box('a', 0, red)])).toEqual([]);
    expect(fixture.textures.some((texture) => texture.label.includes('/image-'))).toBe(false);
    expect(fixture.samplers.some((sampler) => sampler.label?.includes('/image-'))).toBe(false);
    creation.dispose();
  });

  it('dispose destroys the image textures', async () => {
    const { fixture, creation, run } = await imageScene(new Map([['k1', ready(2, 2)]]));
    run([box('a', 0, image('k1'))]);
    creation.dispose();
    const created = fixture.textures
      .map((texture) => texture.label)
      .filter((label) => label.includes('/image-'));
    expect(created.length).toBe(2);
    for (const label of created) expect(fixture.destroyed).toContain(label);
  });
});

describe('V32-K9 image paint changes rebuild no geometry', () => {
  it('a key, wrap or transform change costs no fill or stroke port call', () => {
    const fillPort = createCountingPort();
    const strokePort = new ScriptedStrokeMeshPort();
    const node = (fill: SceneImagePaint) =>
      strokedNode('p', 0, { fill: fill as never, stroke: null }) as RenderNodeSnapshot;
    const h = createStrokeHarness({
      fillPort,
      strokePort,
      paints: 'image',
      nodes: [node(image('k1')), pathNode('q', 40)],
    });
    h.prepare();
    const calls = fillPort.callCount;
    const strokeCalls = strokePort.callCount;
    const builds = h.statistics();
    expect(calls).toBeGreaterThan(0);
    for (const fill of [
      image('k2'),
      image('k2', { wrapX: 'repeat', wrapY: 'repeat' }),
      image('k2', { transform: [5, 0, 0, 20, 1, 1] }),
    ]) {
      expect(h.replace([node(fill), pathNode('q', 40)]).status).toBe('applied');
      h.prepare();
    }
    expect(fillPort.callCount).toBe(calls);
    expect(strokePort.callCount).toBe(strokeCalls);
    expect(h.statistics()).toEqual(builds);
  });
});

describe('V32-K5 texture store under the budget', () => {
  it('refuses a texture that does not fit this frame, reports it once, and evicts later', () => {
    const fixture = nativeFixture();
    const tracked = new Set<string>();
    const resources = {
      track: (id: string) => void tracked.add(id),
      release: (id: string) => void tracked.delete(id),
    };
    const { port, requests } = scriptedPort(
      new Map([
        ['k1', ready(2, 2)],
        ['k2', ready(2, 2)],
      ]),
    );
    const store = new ImageTextureStore(
      fixture.device,
      resources,
      'v32',
      port,
      mipChainBytes(2, 2),
    );
    store.beginFrame();
    expect(store.resolve('k1').key).toBe('k1');
    expect(store.resolve('k2').key).toBe('');
    // Refused, and not requested again while it cannot fit (k1 is drawn in this frame).
    expect(store.resolve('k2').key).toBe('');
    expect(requests).toEqual(['k1', 'k2']);
    expect(store.takeNotices()).toEqual([{ key: 'k2', kind: 'resource-limit' }]);
    store.beginFrame();
    expect(store.resolve('k2').key).toBe('k2');
    expect(requests).toEqual(['k1', 'k2', 'k2']);
    expect(fixture.destroyed).toContain('v32/image-0');
    expect(tracked.has('v32/image-0')).toBe(false);
    expect(tracked.has('v32/image-1')).toBe(true);
    expect(store.residentBytes).toBe(mipChainBytes(2, 2));
    // k1 refused now that k2 is drawn in this frame, and reported again as a new refusal.
    expect(store.resolve('k1').key).toBe('');
    expect(store.takeNotices()).toEqual([{ key: 'k1', kind: 'resource-limit' }]);
    store.dispose();
    expect(tracked.size).toBe(0);
  });
});

describe('V32-S3 renderer service options', () => {
  it('paints image needs a valid port, subscribes to it and asks for the paint variants', () => {
    const invalidate = { invalidate: vi.fn(), setMode: vi.fn() };
    expect(() => new PrimitiveRendererService(invalidate, { paints: 'image' })).toThrow(
      "paints: 'image' needs an imageSource port.",
    );
    const bad = { portVersion: 1 } as unknown as ImageSourcePort;
    expect(
      () => new PrimitiveRendererService(invalidate, { paints: 'image', imageSource: bad }),
    ).toThrow(TypeError);
    let listener: ((keys: readonly string[]) => void) | null = null;
    const unsubscribe = vi.fn();
    const port: ImageSourcePort = {
      portVersion: 0,
      operationId: 'v32-u3/subscribed',
      request: () => ({ status: 'pending' }),
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
    };
    const service = new PrimitiveRendererService(invalidate, {
      paints: 'image',
      imageSource: port,
    });
    expect(service.requiresPaintPipeline).toBe(true);
    expect(service.imageSource).toBe(port);
    listener!(['k1']);
    expect(invalidate.invalidate).toHaveBeenCalledWith({ reason: 'scene' });
    service.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('an untransformed image paint on an untransformed node maps identically', () => {
    const record = buildGradientRecord(image('k', { transform: IDENTITY }), IDENTITY, {
      x: 0,
      y: 0,
    }) as ImagePaintRecord;
    expect(record.map.map((lane) => lane + 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
