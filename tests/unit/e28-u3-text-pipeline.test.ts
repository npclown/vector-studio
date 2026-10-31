import { createHash } from 'node:crypto';

import type {
  RendererDiagnostic,
  RendererInvalidationTarget,
  RenderNodeSnapshot,
  SceneAffine,
  SceneColor,
} from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import {
  PrimitiveRendererService as PackageService,
  type AnimationFrameClock,
} from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuDevicePort,
  type WebGpuPlatform,
  type WebGpuPrimitiveScenePort,
} from '@vector-studio/renderer-webgpu';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type {
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveSubmitResult,
  TextPacketPart,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import {
  E28_RASTER_PER_FRAME,
  TEXT_INSTANCE_FLOATS,
} from '../../packages/renderer-core/src/text-atlas.js';
import {
  CANVAS_GLYPH_RASTER_OPERATION_ID,
  createCanvasGlyphRaster,
} from '../../packages/renderer-webgpu/src/canvas-glyph-raster.js';
import { CLIP_BLOCK } from '../../packages/renderer-webgpu/src/clip-pipeline.js';
import { LAYER_BLOCK } from '../../packages/renderer-webgpu/src/layer-pipeline.js';
import {
  TEXT_CLIP_LAYER_SHADER,
  TEXT_CLIP_SHADER,
  TEXT_LAYER_SHADER,
  TEXT_SHADER,
  textPipelineKey,
} from '../../packages/renderer-webgpu/src/text-pipeline.js';
import { FakeRaster, many, textNode } from '../support/e28-text-harness.js';
import { nativeFixture, nativeScene } from '../support/p4-native-fixture.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), unit U3: the text pipeline and
// its variants (section 4, Text pipeline), atlas pages, clears and uploads, the receipt's text
// part, text draws in the main pass and in layers, accounting and lifetime, E28-D1 to D3 from the
// backend and the canvas raster port. Fake device seams only: the unit part of E28-A05, the hash,
// key and count part of E28-A07 and the carried U2 gaps. The SwiftShader captures (A07) are in
// docs/evidence/e28/.

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const textPipeline = 'vector-studio/e28-text-stencil-4x';
const p1 = 'vector-studio/p1-analytic-primitive-stencil-4x';
const layerEmpty = 'primitive/1/layer-empty-bind-group';

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
  parentId: string | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity,
    kind: 'container',
    clip,
    children,
  };
}

const sceneOptions = {
  meshPipeline: true,
  clipPipeline: true,
  layerPipeline: true,
  textPipeline: true,
} as const;

/** The service and the fake-device scene, with frames that submit and acknowledge. */
async function setup(
  nodes: readonly RenderNodeSnapshot[],
  options: Readonly<{
    pages?: number;
    pageSize?: number;
    scene?: Parameters<typeof nativeScene>[1];
    fixture?: Parameters<typeof nativeFixture>[0];
  }> = {},
) {
  const fixture = nativeFixture(options.fixture);
  const native = await nativeScene(fixture, options.scene ?? sceneOptions);
  const port = new FakeRaster();
  const reasons: string[] = [];
  const invalidation: RendererInvalidationTarget = {
    invalidate: ({ reason }) => {
      reasons.push(reason);
    },
    setMode: () => undefined,
  };
  const pathPort = createCountingPort();
  const service = new PrimitiveRendererService(invalidation, {
    clips: 'all',
    groups: 'isolated',
    text: 'atlas',
    glyphRaster: port,
    fillMesh: pathPort,
    ...(options.pages === undefined ? {} : { textAtlasPagesForTesting: options.pages }),
    ...(options.pageSize === undefined ? {} : { textAtlasPageSizeForTesting: options.pageSize }),
  });
  service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  let revision = 0;
  const replace = (next: readonly RenderNodeSnapshot[]) => {
    revision += 1;
    const result = service.replaceSnapshot({
      identity: { documentId: 'e28-u3', pageId: 'page' },
      revision,
      nodes: next,
      rootOrder: next.filter((node) => node.parentId === null).map((node) => node.id),
    });
    expect(result.status).toBe('applied');
  };
  replace(nodes);
  let target = native.target;
  /** Prepares, submits and (unless told not to) acknowledges a frame. */
  const frame = (acknowledge = true) => {
    const packet = service.prepare(target)!;
    expect(packet).not.toBeNull();
    const result = native.scene.submitPrimitivePacket(packet);
    if (acknowledge && result.status === 'submitted') service.acknowledge(result.receipt);
    return { packet, result };
  };
  const resize = (width: number, height: number) => {
    target = { ...target, surfaceRevision: target.surfaceRevision + 1, width, height };
    native.scene.setTarget(target);
  };
  const takeInvalidations = () => reasons.splice(0).filter((reason) => reason === 'scene').length;
  return {
    ...native,
    fixture,
    port,
    pathPort,
    service,
    replace,
    frame,
    resize,
    takeInvalidations,
  };
}

function receiptOf(result: PrimitiveSubmitResult): PrimitiveReceipt {
  if (result.status !== 'submitted') throw new Error(`not submitted: ${result.status}`);
  return result.receipt;
}

/** The pass calls between a pass's begin and end, without the vertex and index buffers. */
function passCalls(calls: readonly (readonly unknown[])[], label: string, nth = 0) {
  let start = -1;
  for (let seen = 0; seen <= nth; seen += 1) {
    start = calls.findIndex((call, index) => index > start && call[1] === label);
  }
  const end = calls.findIndex((call, index) => index > start && call[0] === 'end');
  return calls
    .slice(start + 1, end)
    .filter((call) => call[0] !== 'setVertexBuffer' && call[0] !== 'setIndexBuffer');
}

const pageBytes = (size: number) => size * size;

describe('E28 U3 text modules (section 4, Text pipeline; E28-A07 hash part)', () => {
  it('pins the four text modules', () => {
    expect({
      plain: hash(TEXT_SHADER),
      clip: hash(TEXT_CLIP_SHADER),
      layer: hash(TEXT_LAYER_SHADER),
      clipLayer: hash(TEXT_CLIP_LAYER_SHADER),
    }).toEqual({
      plain: '49df3e30d26b72e39e189395df937515d2bdd559e4f3b3539f22c353085c8f12',
      clip: '4e4a35485daef8b0e692169581b8bde30345453a2fac262da7f1ab69f768cbea',
      layer: 'fb255be84c0a0adc371de4d8446fa71ccb6ff486de203dd875740d18c330781c',
      clipLayer: '1f030a8c4ec48ed015a7c12837f4d0ff244300865e21e403a87ea823b7a791d5',
    });
  });

  it('wraps the fragment stage by the clip block and shifts every position read in layers', () => {
    expect(TEXT_CLIP_SHADER).toContain(CLIP_BLOCK);
    expect(TEXT_CLIP_SHADER).toContain('fn shadeText(input: TextVertexOutput) -> vec4f {');
    expect(TEXT_CLIP_SHADER).toContain('return shadeText(input) * clip;');
    for (const [base, variant] of [
      [TEXT_SHADER, TEXT_LAYER_SHADER],
      [TEXT_CLIP_SHADER, TEXT_CLIP_LAYER_SHADER],
    ] as const) {
      const reads = base.split('input.position.xy').length - 1;
      expect(reads).toBeGreaterThan(0);
      expect(variant.split('(input.position.xy + layerPass.shift)').length - 1).toBe(reads);
      expect(variant.endsWith(LAYER_BLOCK)).toBe(true);
    }
    // Snapped mode loads one texel; general mode samples bilinearly at level 0, inset clamped.
    expect(TEXT_SHADER).toContain('textureLoad(textPage');
    expect(TEXT_SHADER).toContain('textureSampleLevel(textPage, textSampler');
    expect(TEXT_SHADER).toContain('clamp(input.bitmap, vec2f(0.5)');
  });

  it('keys the variants under e28-text-v0 with the clip and layer suffixes', () => {
    expect(textPipelineKey('bgra8unorm', 4, true)).toEqual({
      shaderKey: 'e28-text-v0',
      layoutKey: 'e28-text-v0',
      vertexLayoutKey: 'none-6-v0',
      targetFormat: 'bgra8unorm',
      renderStateKey: 'premultiplied-source-over/stencil8-keep/no-cull/triangle-list-v1',
      sampleCount: 4,
    });
    expect(textPipelineKey('rgba8unorm', 1, false, 'clip-layer')).toMatchObject({
      shaderKey: 'e28-text-v0+clip-v0+layer-v0',
      layoutKey: 'e28-text-v0+p4-clip-v0+e25-layer-v0',
      renderStateKey: 'premultiplied-source-over/no-depth/no-cull/triangle-list-v1',
      sampleCount: 1,
    });
    expect(textPipelineKey('bgra8unorm', 4, false, 'clip').shaderKey).toBe('e28-text-v0+clip-v0');
    expect(textPipelineKey('bgra8unorm', 4, false, 'layer').layoutKey).toBe(
      'e28-text-v0+e25-layer-v0',
    );
  });
});

describe('E28 U3 creation (E28-A07 counts, E28-A05 accounting)', () => {
  const counts = async (options: Parameters<typeof nativeScene>[1]) => {
    const fixture = nativeFixture();
    const { scene, accounting, creation } = await nativeScene(fixture, options);
    const result = {
      modules: scene.shaderModulesCreated,
      pipelines: scene.pipelinesCreated,
      labels: fixture.pipelineLabels.filter((label) => label.includes('e28-text')),
      modulesCreated: fixture.modules.length,
      samplers: accounting.snapshot().byCategory.sampler.live,
      available: scene.textPipelineAvailable,
    };
    creation.dispose();
    return result;
  };

  it('adds exactly one module and one pipeline per variant the generation has', async () => {
    const base = await counts({ meshPipeline: true, clipPipeline: true, layerPipeline: true });
    const all = await counts(sceneOptions);
    expect(base.labels).toEqual([]);
    expect(base.samplers).toBe(0);
    expect(all.modules - base.modules).toBe(4);
    expect(all.pipelines - base.pipelines).toBe(4);
    expect(all.modulesCreated - base.modulesCreated).toBe(4);
    expect(all.labels).toEqual([
      textPipeline,
      `${textPipeline}+clip-v0`,
      `${textPipeline}+layer-v0`,
      `${textPipeline}+clip-v0+layer-v0`,
    ]);
    expect(all.samplers).toBe(1);
    expect(all.available).toBe(true);
    const withoutLayer = await counts({
      meshPipeline: true,
      clipPipeline: true,
      textPipeline: true,
    });
    expect(withoutLayer.labels).toEqual([textPipeline, `${textPipeline}+clip-v0`]);
    const plain = await counts({ textPipeline: true });
    expect(plain.labels).toEqual(['vector-studio/e28-text-4x']);
    expect(plain.modules).toBe(2);
    expect(plain.pipelines).toBe(2);
  });

  it('lays out groups 0 to 3 as text, clip or empty, empty, layer', async () => {
    const fixture = nativeFixture();
    const { creation } = await nativeScene(fixture, sceneOptions);
    const layouts = fixture.descriptors
      .filter((descriptor) => descriptor.label?.includes('e28-text'))
      .map((descriptor) =>
        (descriptor.layout as unknown as { groups: { label: string }[] }).groups.map(
          (layout) => layout.label,
        ),
      );
    const text = 'vector-studio/e28-text-layout';
    const clip = 'vector-studio/p4-clip-layout';
    const empty = 'primitive/1/layer-empty-bind-group-layout';
    const layer = 'vector-studio/e25-layer-layout';
    expect(layouts).toEqual([
      [text],
      [text, clip],
      [text, empty, empty, layer],
      [text, clip, empty, layer],
    ]);
    const descriptor = fixture.descriptors.find((item) => item.label === textPipeline)!;
    expect(descriptor.vertex.buffers).toEqual([]);
    expect(descriptor.depthStencil).toMatchObject({
      stencilWriteMask: 0,
      stencilFront: { compare: 'always', passOp: 'keep' },
    });
    expect(descriptor.fragment!.targets[0]).toMatchObject({
      blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
    });
    expect(fixture.samplers).toEqual([
      expect.objectContaining({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    ]);
    creation.dispose();
  });

  it('leaves text unavailable, and nothing of it tracked, when a text pipeline fails', async () => {
    const fixture = nativeFixture({ failPipeline: 'e28-text-stencil-4x+layer' });
    const { scene, accounting, creation } = await nativeScene(fixture, sceneOptions);
    const baseline = nativeFixture();
    const base = await nativeScene(baseline, {
      meshPipeline: true,
      clipPipeline: true,
      layerPipeline: true,
    });
    expect(scene.textPipelineAvailable).toBe(false);
    expect(scene.shaderModulesCreated).toBe(base.scene.shaderModulesCreated);
    expect(scene.pipelinesCreated).toBe(base.scene.pipelinesCreated);
    expect(accounting.snapshot().live).toBe(base.accounting.snapshot().live);
    creation.dispose();
    base.creation.dispose();
  });
});

describe('E28 U3 pages, clears, uploads and the receipt (section 4, Lifetime)', () => {
  it('creates pages as the packet asks, uploads, and reports incarnations in the receipt', async () => {
    const { frame, fixture, accounting, service } = await setup([textNode('t', many(3))]);
    const before = accounting.snapshot().byCategory.texture.liveBytes;
    const { packet, result } = frame();
    const receipt = receiptOf(result);
    expect(packet.text!.pageCount).toBe(1);
    const page = fixture.textures.find((texture) => texture.label.includes('text-page'))!;
    // TEXTURE_BINDING | COPY_DST, never RENDER_ATTACHMENT.
    expect(page).toEqual({
      label: 'primitive/1/text-page-1',
      format: 'r8unorm',
      sampleCount: 1,
      width: 2048,
      height: 2048,
      usage: 0x04 | 0x02,
    });
    expect(accounting.snapshot().byCategory.texture.liveBytes - before).toBe(pageBytes(2048));
    expect(fixture.textureWrites.map((write) => [write.x, write.width, write.bytesPerRow])).toEqual(
      packet.text!.uploads.map((upload) => [upload.x, upload.width, upload.width]),
    );
    expect(fixture.textureWrites[0]!.bytes).toBe(packet.text!.uploads[0]!.coverage);
    expect(receipt.text).toEqual({
      pages: [expect.any(Symbol)],
      clears: 0,
      uploads: 3,
    });
    expect(service.getGlyphUploadsForTesting()).toBe(3);
    // The next frame reuses the page: no texture, no write, the same incarnation.
    service.setCamera({ position: { x: 1, y: 0 }, zoom: 1 });
    fixture.textureWrites.length = 0;
    const next = receiptOf(frame().result);
    expect(fixture.textureWrites).toEqual([]);
    expect(next.text!.pages).toEqual(receipt.text!.pages);
    expect(fixture.textures.filter((texture) => texture.label.includes('text-page'))).toHaveLength(
      1,
    );
  });

  it('zeroes a page written by a replaced packet before its next uploads', async () => {
    const { frame, fixture, replace } = await setup([textNode('t', many(1))]);
    frame();
    replace([textNode('t', many(2))]);
    frame(false);
    fixture.textureWrites.length = 0;
    const { packet } = frame();
    expect(packet.text!.clears).toEqual([{ page: 0, x: 0, y: 0, width: 2048, height: 2048 }]);
    // The clear arrives in bands of 32 rows (64 KiB of zeros at 2,048 bytes a row), then the uploads.
    const bands = fixture.textureWrites.slice(0, 64);
    expect(
      bands.map((band) => [band.x, band.y, band.width, band.height, band.bytesPerRow]),
    ).toEqual(Array.from({ length: 64 }, (_, index) => [0, index * 32, 2048, 32, 2048]));
    expect(bands.every((band) => band.bytes.every((value) => value === 0))).toBe(true);
    expect(bands[0]!.bytes.byteLength).toBe(64 * 1024);
    const uploads = fixture.textureWrites.slice(64);
    expect(uploads).toHaveLength(2);
    expect(uploads.map((upload) => upload.bytes)).toEqual(
      packet.text!.uploads.map((upload) => upload.coverage),
    );
  });

  it('keeps pages on resize and for culled text, and releases them with the last text node', async () => {
    const { frame, fixture, accounting, replace, resize, service } = await setup([
      textNode('t', many(2)),
      box('a', 0),
    ]);
    frame();
    resize(320, 200);
    frame();
    expect(fixture.destroyed.filter((label) => label.includes('text-page'))).toEqual([]);
    service.setCamera({ position: { x: 5000, y: 0 }, zoom: 1 });
    const culled = frame();
    expect(culled.packet.text).toMatchObject({ pageCount: 1, draws: [] });
    // No text draw: the text buffer goes, the page stays.
    expect(fixture.destroyed).toEqual(expect.not.arrayContaining(['primitive/1/text-page-1']));
    const live = accounting.snapshot().byCategory.texture.liveBytes;
    replace([box('a', 0)]);
    const last = frame();
    expect(last.packet.text).toMatchObject({ pageCount: 0 });
    expect(receiptOf(last.result).text).toEqual({ pages: [], clears: 0, uploads: 0 });
    expect(fixture.destroyed).toContain('primitive/1/text-page-1');
    expect(accounting.snapshot().byCategory.texture.liveBytes).toBe(live - pageBytes(2048));
    const after = frame();
    expect(after.packet.text).toBeUndefined();
  });

  it('releases pages, the text buffer and the sampler on dispose', async () => {
    const { frame, accounting, creation } = await setup([textNode('t', many(2))]);
    frame();
    expect(accounting.snapshot().byCategory.sampler.live).toBe(1);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('grows the text buffer by powers of two and writes the target uniform when it changes', async () => {
    const { frame, fixture, replace, resize } = await setup([textNode('t', many(1))]);
    frame();
    const textWrites = () => fixture.writes.filter((write) => write.label.includes('text-buffer'));
    expect(textWrites()).toEqual([
      { label: 'primitive/1/text-buffer-1', offset: 0, bytes: 16 },
      { label: 'primitive/1/text-buffer-1', offset: 256, bytes: 64 },
    ]);
    fixture.writes.length = 0;
    replace([textNode('t', many(9))]);
    frame();
    // 256 + 9 × 64 bytes: a new buffer of 1024 bytes, and its uniform.
    expect(textWrites()).toEqual([
      { label: 'primitive/1/text-buffer-2', offset: 0, bytes: 16 },
      { label: 'primitive/1/text-buffer-2', offset: 256, bytes: 576 },
    ]);
    fixture.writes.length = 0;
    replace([textNode('t', many(8))]);
    frame();
    expect(textWrites()).toEqual([{ label: 'primitive/1/text-buffer-2', offset: 256, bytes: 512 }]);
    fixture.writes.length = 0;
    resize(320, 200);
    replace([textNode('t', many(7))]);
    frame();
    expect(textWrites()[0]).toEqual({ label: 'primitive/1/text-buffer-2', offset: 0, bytes: 16 });
    // The instance write's size argument counts Float32Array elements, not bytes.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a mock, read for its calls
    const writeBuffer = fixture.device.queue.writeBuffer as unknown as Mock<
      (...args: unknown[]) => unknown
    >;
    const instanceWrite = writeBuffer.mock.calls
      .filter(
        (call) => (call[0] as { label: string }).label.includes('text-buffer') && call[1] === 256,
      )
      .at(-1)!;
    expect(instanceWrite[2]).toBeInstanceOf(Float32Array);
    expect(instanceWrite[3]).toBe(0);
    expect(instanceWrite[4]).toBe((instanceWrite[2] as Float32Array).length);
    expect(instanceWrite[4]).toBe(7 * TEXT_INSTANCE_FLOATS);
  });
});

describe('E28 U3 text draws (section 4, Order key; E28-K7, K8)', () => {
  it('draws a text leaf at its paint position in the main pass', async () => {
    const { frame, fixture } = await setup([box('a', 0), textNode('t', many(2)), box('b', 40)]);
    fixture.calls.length = 0;
    frame();
    expect(passCalls(fixture.calls, 'vector-studio/primitive-pass')).toEqual([
      ['setPipeline', p1],
      ['setBindGroup', 0, 'primitive/1/arena-1/bind-group'],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['setPipeline', textPipeline],
      ['setBindGroup', 0, 'primitive/1/text-buffer-1/text-page-1'],
      ['draw', 6, 2, 0, 0],
      ['setPipeline', p1],
      ['setBindGroup', 0, 'primitive/1/arena-1/bind-group'],
      ['drawIndexed', 6, 1, 0, 0, 1],
    ]);
  });

  it('orders text against mesh draws and composites at one position', async () => {
    const { frame, fixture } = await setup([
      pathNode('p', 1),
      textNode('t', many(1)),
      group('g', ['b']),
      box('b', 40, 'g'),
      textNode('u', many(1, 5)),
    ]);
    fixture.calls.length = 0;
    const { packet } = frame();
    expect(packet.text!.draws.map((draw) => [draw.position, draw.order])).toEqual([
      [0, 1],
      [0, 3],
    ]);
    const kinds = passCalls(fixture.calls, 'vector-studio/primitive-pass')
      .filter((call) => call[0] === 'setPipeline')
      .map((call) => call[1]);
    expect(kinds).toEqual([
      p1,
      'vector-studio/p3-mesh-fill-4x',
      textPipeline,
      'vector-studio/e25-layer-composite-stencil-4x',
      textPipeline,
    ]);
  });

  it('draws clipped text with the clip variant and its state', async () => {
    const { frame, fixture } = await setup([
      group('c', ['t'], 1, { kind: 'rect', x: 0, y: 0, width: 30, height: 40 }),
      textNode('t', many(2), { parentId: 'c' }),
    ]);
    fixture.calls.length = 0;
    const { packet } = frame();
    expect(packet.text!.draws[0]!.clipState).toBe(1);
    expect(passCalls(fixture.calls, 'vector-studio/primitive-pass')).toEqual([
      ['setPipeline', p1],
      ['setBindGroup', 0, 'primitive/1/arena-1/bind-group'],
      ['setPipeline', `${textPipeline}+clip-v0`],
      ['setBindGroup', 0, 'primitive/1/text-buffer-1/text-page-1'],
      ['setBindGroup', 1, 'primitive/1/clip-states-1/bind-group', 1280],
      ['draw', 6, 2, 0, 0],
    ]);
  });

  it('draws text in a layer with the layer variant, after mesh draws and before composites', async () => {
    const { frame, fixture } = await setup([
      group('g', ['p', 't', 'h', 'c']),
      pathNode('p', 1, { parentId: 'g' }),
      textNode('t', many(1), { parentId: 'g' }),
      group('h', ['b'], 0.5, null, 'g'),
      box('b', 40, 'h'),
      group('c', ['u'], 1, { kind: 'rect', x: 0, y: 0, width: 30, height: 40 }, 'g'),
      textNode('u', many(1, 3), { parentId: 'c' }),
    ]);
    fixture.calls.length = 0;
    const { packet } = frame();
    expect(packet.text!.draws.map((draw) => draw.target)).toEqual([1, 1]);
    expect(
      passCalls(fixture.calls, 'vector-studio/primitive-pass').some(
        (call) => call[0] === 'draw' && call[1] === 6 && call.length === 5,
      ),
    ).toBe(false);
    const calls = passCalls(fixture.calls, 'vector-studio/layer-pass/1');
    const frameId = 'primitive/1/layer-frame-1';
    expect(
      calls.filter((call) => call[0] !== 'setStencilReference' && call[0] !== 'setViewport'),
    ).toEqual([
      ['setBindGroup', 3, `${frameId}/pass-bind-group`, 512],
      ['setPipeline', 'vector-studio/p3-mesh-fill-4x+layer-v0'],
      ['setBindGroup', 0, 'primitive/1/mesh-arena-2/bind-group'],
      ['setBindGroup', 1, layerEmpty],
      ['setBindGroup', 2, layerEmpty],
      ['draw', 3 * packet.layers!.layers[1]!.meshDraws[0]!.triangleCount, 1, 0, 0],
      ['setPipeline', `${textPipeline}+layer-v0`],
      ['setBindGroup', 0, 'primitive/1/text-buffer-1/text-page-1'],
      ['draw', 6, 1, 0, 0],
      ['setPipeline', 'vector-studio/e25-layer-composite-stencil-4x'],
      ['setBindGroup', 0, `${frameId}/composite-0`],
      ['setBindGroup', 1, layerEmpty],
      ['setBindGroup', 2, layerEmpty],
      ['setBindGroup', 3, `${frameId}/pass-bind-group`, 512],
      ['draw', 6],
      ['setPipeline', `${textPipeline}+clip-v0+layer-v0`],
      ['setBindGroup', 0, 'primitive/1/text-buffer-1/text-page-1'],
      ['setBindGroup', 1, 'primitive/1/clip-states-1/bind-group', 1280],
      ['draw', 6, 1, 0, 1],
    ]);
  });

  it('splits draws at a page change and binds each page', async () => {
    const { frame, fixture } = await setup([textNode('t', many(6), { size: 12 })], {
      pageSize: 32,
    });
    fixture.calls.length = 0;
    const { packet } = frame();
    expect(packet.text!.pageCount).toBeGreaterThan(1);
    const groups = passCalls(fixture.calls, 'vector-studio/primitive-pass')
      .filter((call) => call[0] === 'setBindGroup' && String(call[2]).includes('text-buffer'))
      .map((call) => call[2]);
    expect(groups).toEqual(
      packet.text!.draws.map((draw) => `primitive/1/text-buffer-1/text-page-${draw.page + 1}`),
    );
  });

  it('makes no path port call for text (E28-A04)', async () => {
    const { frame, pathPort } = await setup([textNode('t', many(4))]);
    frame();
    frame();
    expect(pathPort.calls).toEqual([]);
  });
});

describe('E28 U3 text unavailable (E28-D1, fail closed)', () => {
  it('without the text pipeline: no page, no draw, and placeholder incarnations that settle', async () => {
    const { frame, fixture, port, service } = await setup([textNode('t', many(2))], {
      scene: { meshPipeline: true, clipPipeline: true, layerPipeline: true },
    });
    fixture.calls.length = 0;
    const first = receiptOf(frame().result);
    expect(fixture.textures.some((texture) => texture.label.includes('text-page'))).toBe(false);
    expect(fixture.textureWrites).toEqual([]);
    expect(fixture.calls.some((call) => call[0] === 'draw' && call[1] === 6)).toBe(false);
    expect(first.text).toEqual({ pages: [expect.any(Symbol)], clears: 0, uploads: 2 });
    service.setCamera({ position: { x: 1, y: 0 }, zoom: 1 });
    const second = receiptOf(frame().result);
    expect(second.text!.pages).toEqual(first.text!.pages);
    expect(port.requests).toHaveLength(2);
  });

  it('after a page allocation failure: text stays undrawn for the generation', async () => {
    const { frame, fixture, scene, accounting } = await setup([textNode('t', many(2))], {
      fixture: { failTexture: 'text-page' },
    });
    const created = () =>
      (fixture.device.createTexture as ReturnType<typeof vi.fn>).mock.calls.length;
    fixture.calls.length = 0;
    const result = frame().result;
    expect(result.status).toBe('submitted');
    expect(scene.textPageAllocationFailed).toBe(true);
    expect(fixture.calls.some((call) => call[0] === 'draw' && call[1] === 6)).toBe(false);
    expect(accounting.snapshot().byCategory.buffer.live).toBeGreaterThan(0);
    const attempts = created();
    frame();
    expect(created()).toBe(attempts);
  });

  it('after a text buffer allocation failure: the same, with the frame still submitted', async () => {
    const { frame, fixture, scene } = await setup([textNode('t', many(2)), box('a', 40)]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a mock, given a new implementation
    const createBuffer = fixture.device.createBuffer as unknown as Mock<
      (descriptor: GPUBufferDescriptor) => unknown
    >;
    const original = createBuffer.getMockImplementation()!;
    createBuffer.mockImplementation((descriptor) => {
      if (String(descriptor.label).includes('text-buffer')) throw new Error('out of memory');
      return original(descriptor);
    });
    fixture.calls.length = 0;
    expect(frame().result.status).toBe('submitted');
    expect(scene.textPageAllocationFailed).toBe(true);
    expect(fixture.calls.some((call) => call[0] === 'draw' && call[1] === 6)).toBe(false);
    expect(fixture.destroyed).toContain('primitive/1/text-page-1');
  });

  it('instances past the storage binding limit fail closed instead of failing the frame', async () => {
    // One key at 80 whole-pixel positions: one raster call, 80 records.
    const same = Array.from({ length: 80 }, (_, index) => ['X', index] as [string, number]);
    const { frame, fixture, scene } = await setup([textNode('t', same)]);
    // 80 records need 5,120 bytes; every other storage binding of this frame fits in 4 KiB.
    (fixture.device.limits as { maxStorageBufferBindingSize: number }).maxStorageBufferBindingSize =
      4096;
    fixture.calls.length = 0;
    const { result } = frame();
    expect(result.status).toBe('submitted');
    expect(receiptOf(result).text).toMatchObject({ pages: [expect.any(Symbol)], uploads: 1 });
    expect(scene.textPageAllocationFailed).toBe(true);
    expect(fixture.textureWrites).toEqual([]);
    expect(fixture.calls.some((call) => call[0] === 'draw' && call[1] === 6)).toBe(false);
  });

  it('skips clipped text when the scene has no clip variants', async () => {
    const { frame, fixture } = await setup(
      [
        group('c', ['t'], 1, { kind: 'rect', x: 0, y: 0, width: 30, height: 40 }),
        textNode('t', many(2), { parentId: 'c' }),
      ],
      { scene: { meshPipeline: true, textPipeline: true } },
    );
    fixture.calls.length = 0;
    expect(frame().result.status).toBe('submitted');
    expect(fixture.calls.some((call) => call[0] === 'draw' && call[1] === 6)).toBe(false);
  });
});

describe('E28 U3 invalid text parts (invalid-packet)', () => {
  const variants: [string, (part: TextPacketPart) => TextPacketPart][] = [
    ['layoutVersion', (part) => ({ ...part, layoutVersion: 1 as 0 })],
    ['pageSize', (part) => ({ ...part, pageSize: 4096 })],
    ['pageCount', (part) => ({ ...part, pageCount: 9 })],
    ['instances', (part) => ({ ...part, instances: part.instances.subarray(1) })],
    ['draw page', (part) => ({ ...part, draws: [{ ...part.draws[0]!, page: 1 }] })],
    ['draw range', (part) => ({ ...part, draws: [{ ...part.draws[0]!, count: 3 }] })],
    ['draw count', (part) => ({ ...part, draws: [{ ...part.draws[0]!, count: 0 }] })],
    ['clip state', (part) => ({ ...part, draws: [{ ...part.draws[0]!, clipState: 1 }] })],
    [
      'upload outside its page',
      (part) => ({ ...part, uploads: [{ ...part.uploads[0]!, x: 2047 }] }),
    ],
    [
      'upload coverage',
      (part) => ({
        ...part,
        uploads: [{ ...part.uploads[0]!, coverage: new Uint8Array(3) }],
      }),
    ],
    ['clear page', (part) => ({ ...part, clears: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }] })],
  ];
  it.each(variants)('%s', async (_name, mutate) => {
    const { service, scene, fixture, target } = await setup([textNode('t', many(2))]);
    const packet = service.prepare(target)!;
    const bad: PrimitivePacket = { ...packet, text: mutate(packet.text!) };
    expect(scene.submitPrimitivePacket(bad)).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
    expect(fixture.textures.some((texture) => texture.label.includes('text-page'))).toBe(false);
    expect(fixture.textureWrites).toEqual([]);
  });
});

describe('E28 U3 carried from U2 (section 4)', () => {
  it('a fallback draws the nearest bucket by the general path, smaller on a tie, phase kept', async () => {
    // Buckets 8 and 12 exist; s = 10 ties, so the smaller (8) is drawn scaled by 10/8.
    const { frame, service, replace } = await setup([
      textNode('a', [['X', 0.25]], { size: 8 }),
      textNode('b', [['X', 0.25]], { size: 12, y: 60 }),
    ]);
    frame();
    const filler = many(E28_RASTER_PER_FRAME, 100).map(
      ([text, x]) => [text, x * 0.01] as [string, number],
    );
    replace([
      textNode('a', [['X', 0.25]], { size: 8 }),
      textNode('b', [['X', 0.25]], { size: 12, y: 60 }),
      textNode('f', filler, { size: 4, y: 100 }),
      textNode('c', [['X', 0.25]], { size: 10, y: 140 }),
    ]);
    const { packet } = frame();
    expect(service.getGlyphRasterCallsForTesting()).toBe(2 + E28_RASTER_PER_FRAME);
    const last = packet.text!.instances.subarray(-TEXT_INSTANCE_FLOATS);
    // General mode, axes scaled by 10/8, entry phase 0.25 kept in the origin.
    expect(last[11]).toBe(1);
    expect(last[2]).toBeCloseTo((10 / 8) * last[8]!, 9);
    expect(last[0]).toBeCloseTo(0.25 + (10 / 8) * -(2 + 0.25), 5);
  });

  it('places snapped clusters at negative coordinates by half-up rounding', async () => {
    const { frame, service } = await setup([textNode('t', [['X', -10.375]], { y: -0.5 })]);
    service.setCamera({ position: { x: -50, y: -50 }, zoom: 1 });
    const { packet } = frame();
    // o = (39.625, 49.5): q = ⌊158.5 + 0.5⌋ = 159, phase 0.75, P = (39, 50).
    const record = packet.text!.instances.subarray(0, TEXT_INSTANCE_FLOATS);
    expect([record[0], record[1], record[11]]).toEqual([39 - 2, 50 - 18, 0]);
  });

  it('an incarnation change on a page that also got this frame’s uploads keeps them', async () => {
    const { frame, service, scene, replace, takeInvalidations, port, target } = await setup([
      textNode('t', many(1)),
    ]);
    frame();
    replace([textNode('t', many(2))]);
    const packet = service.prepare(target)!;
    expect(packet.text!.uploads).toHaveLength(1);
    const receipt = receiptOf(scene.submitPrimitivePacket(packet));
    takeInvalidations();
    // As if the backend had recreated page 0 before this packet's upload.
    service.acknowledge({ ...receipt, text: { ...receipt.text!, pages: [Symbol('recreated')] } });
    expect(takeInvalidations()).toBe(1);
    port.requests.length = 0;
    frame();
    // Only the earlier packet's entry was lost.
    expect(port.requests.map((request) => request.text)).toEqual([many(1)[0]![0]]);
  });

  it('a packet replaced after an eviction leaves its page cleared and its entries dropped', async () => {
    // Each bitmap is 16 × 28 px, so a 32 px page holds one.
    const { frame, replace, port } = await setup([textNode('t', many(1), { size: 20 })], {
      pages: 1,
      pageSize: 32,
    });
    frame();
    replace([textNode('t', many(1, 1), { size: 20 })]);
    const evicting = frame(false);
    expect(evicting.packet.text!.clears).toHaveLength(1);
    replace([textNode('t', many(1), { size: 20 })]);
    port.requests.length = 0;
    const { packet } = frame();
    // The first cluster's entry went with the page the replaced packet cleared.
    expect(port.requests.map((request) => request.text)).toEqual([many(1)[0]![0]]);
    expect(packet.text!.clears).toEqual([{ page: 0, x: 0, y: 0, width: 32, height: 32 }]);
  });
});

class ManualClock implements AnimationFrameClock {
  readonly #callbacks = new Map<number, (timestamp: number) => void>();
  #next = 1;
  request(callback: (timestamp: number) => void): number {
    const handle = this.#next;
    this.#next += 1;
    this.#callbacks.set(handle, callback);
    return handle;
  }
  cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }
  flush(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(16);
  }
}

function fakeDevice(scene: Partial<WebGpuPrimitiveScenePort>) {
  const port: WebGpuPrimitiveScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    clipPipelineAvailable: true,
    setTarget: vi.fn(),
    submitPrimitivePacket: vi.fn(() => ({ status: 'not-ready' as const })),
    dispose: vi.fn(),
    ...scene,
  };
  const createPrimitiveScene = vi.fn(() => ({
    result: Promise.resolve({ scene: port, fellBackFrom4x: false }),
    dispose: () => port.dispose(),
  }));
  const device: WebGpuDevicePort = {
    features: [],
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 },
    lost: new Promise(() => {}),
    createFoundationScene: () => {
      throw new Error('foundation mode is not used here');
    },
    createPrimitiveScene,
    waitForSubmittedWork: vi.fn(() => Promise.resolve()),
    subscribeErrors: vi.fn(() => ({ disposed: false, dispose: vi.fn() })),
    triggerValidationErrorForTesting: vi.fn(),
    destroy: vi.fn(),
  };
  const adapter: WebGpuAdapterPort = { info: {}, requestDevice: () => Promise.resolve(device) };
  const platform: WebGpuPlatform = {
    secureContext: true,
    apiAvailable: true,
    requestAdapter: vi.fn(() => Promise.resolve(adapter)),
    getCanvasContext: vi.fn(() => ({ configure: vi.fn(), unconfigure: vi.fn() })),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  };
  return { platform, createPrimitiveScene, port };
}

async function startBackend(
  scene: Partial<WebGpuPrimitiveScenePort>,
  nodes: readonly RenderNodeSnapshot[],
  backendOptions: ConstructorParameters<typeof WebGpuBackend>[0] = {},
) {
  const device = fakeDevice(scene);
  const clock = new ManualClock();
  const backend = new WebGpuBackend({
    platform: device.platform,
    animationFrameClock: clock,
    ...backendOptions,
  });
  const diagnostics: RendererDiagnostic[] = [];
  backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
  const service = new PackageService(backend, {
    clips: 'rect',
    text: 'atlas',
    glyphRaster: new FakeRaster(),
  });
  backend.attachPrimitiveFrameSource(service);
  await backend.initialize({
    canvas: { width: 0, height: 0 } as HTMLCanvasElement,
    cssSize: { width: 640, height: 360 },
    devicePixelRatio: 1,
  });
  service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  service.replaceSnapshot({
    identity: { documentId: 'e28-u3', pageId: 'page' },
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  });
  clock.flush();
  const of = (code: string) => diagnostics.filter((diagnostic) => diagnostic.code === code);
  return { backend, service, clock, device, of };
}

describe('E28 U3 backend wiring and diagnostics (E28-D1 to D3)', () => {
  it('asks for the text pipeline exactly when the source draws text', async () => {
    const { backend, service, device } = await startBackend({ textPipelineAvailable: true }, []);
    expect(device.createPrimitiveScene.mock.calls[0]).toContainEqual({
      clipPipeline: true,
      textPipeline: true,
    });
    backend.dispose();
    service.dispose();
  });

  it('reports render.text-unavailable once per generation for a missing pipeline', async () => {
    const { backend, service, clock, of } = await startBackend({}, [textNode('t', many(1))]);
    backend.invalidate({ reason: 'interaction' });
    clock.flush();
    expect(of(DIAGNOSTIC_CODES.TEXT_UNAVAILABLE)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        generation: 1,
        context: { reason: 'pipeline' },
      }),
    ]);
    backend.dispose();
    service.dispose();
  });

  it('reports a page allocation failure once', async () => {
    const { backend, service, clock, of } = await startBackend(
      { textPipelineAvailable: true, textPageAllocationFailed: true },
      [textNode('t', many(1))],
    );
    backend.invalidate({ reason: 'interaction' });
    clock.flush();
    expect(of(DIAGNOSTIC_CODES.TEXT_UNAVAILABLE)).toEqual([
      expect.objectContaining({ generation: 1, context: { reason: 'page-allocation' } }),
    ]);
    backend.dispose();
    service.dispose();
  });

  it('emits the packet’s E28-D2 and D3 notices', async () => {
    const { backend, service, of } = await startBackend({ textPipelineAvailable: true }, [
      textNode('t', [
        ['FAIL', 0],
        ['THROW', 20],
      ]),
    ]);
    expect(of(DIAGNOSTIC_CODES.GLYPH_RASTER_FAILURE).map((item) => item.context)).toEqual([
      { nodeId: 't', reason: 'unavailable' },
      { nodeId: 't', reason: 'threw' },
    ]);
    backend.dispose();
    service.dispose();
  });

  it('with test hooks, an unavailable text pipeline fails creation', async () => {
    const { backend, service } = await startBackend({}, [], { frameCaptureForTesting: true });
    expect(backend.state).not.toBe('ready');
    backend.dispose();
    service.dispose();
  });
});

/** A fake 2D context: measureText from a table, fillText records, alpha from a pattern. */
function fakeCanvas(
  metrics: Readonly<{ left: number; right: number; ascent: number; descent: number }>,
  options: Readonly<{ parses?: boolean }> = {},
) {
  const fills: [string, number, number, string][] = [];
  let font = '10px sans-serif';
  const context = {
    get font() {
      return font;
    },
    set font(value: string) {
      if (options.parses === false && !value.includes('sentinel')) return;
      font = value;
    },
    lang: '',
    textBaseline: 'top',
    textAlign: 'start',
    fillStyle: '',
    measureText: vi.fn(() => ({
      actualBoundingBoxLeft: metrics.left,
      actualBoundingBoxRight: metrics.right,
      actualBoundingBoxAscent: metrics.ascent,
      actualBoundingBoxDescent: metrics.descent,
    })),
    clearRect: vi.fn(),
    fillText: vi.fn((text: string, x: number, y: number) => fills.push([text, x, y, font])),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < width * height; index += 1) data[index * 4 + 3] = index % 251;
      return { data };
    }),
  };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
  const createCanvas = vi.fn((width: number, height: number) => {
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as OffscreenCanvas;
  });
  return { createCanvas, context, fills, canvas };
}

describe('E28 U3 canvas raster port (section 2; E28-A08 unit part)', () => {
  const request = {
    text: 'g',
    fontList: '"Arial", sans-serif',
    lang: 'en',
    pixelSize: 16,
    phaseX: 0.5,
  } as const;

  it('measures the box with a 2 px pad and draws at (left + phase, top)', () => {
    const fake = fakeCanvas({ left: 1.2, right: 7.1, ascent: 8.4, descent: 3.5 });
    const port = createCanvasGlyphRaster({ createCanvas: fake.createCanvas });
    expect(port.portVersion).toBe(0);
    expect(port.operationId).toBe(CANVAS_GLYPH_RASTER_OPERATION_ID);
    const result = port.rasterize(request);
    // left = 2 + 2, top = 2 + 9, width = 4 + ⌈7.6⌉ + 2, height = 11 + 4 + 2.
    expect(result).toMatchObject({ status: 'ok', width: 14, height: 17, left: 4, top: 11 });
    expect(fake.fills).toEqual([['g', 4.5, 11, '16px "Arial", sans-serif']]);
    expect(fake.context.lang).toBe('en');
    expect(fake.context.textBaseline).toBe('alphabetic');
    expect(fake.context.textAlign).toBe('left');
    // Black text, coverage from alpha (E28 amendment 2026-10-31: white text's alpha is not the
    // coverage of the dark text the browser paints).
    expect(fake.context.fillStyle).toBe('#000000');
    expect(CANVAS_GLYPH_RASTER_OPERATION_ID).toBe('canvas-2d/raster-v1');
    const coverage = (result as { coverage: Uint8Array }).coverage;
    expect(coverage).toHaveLength(14 * 17);
    expect([coverage[0], coverage[200], coverage[237]]).toEqual([0, 200, 237]);
    expect(fake.canvas.getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true });
    // Identical requests give identical results.
    expect(port.rasterize(request)).toEqual(result);
  });

  it('returns empty for whitespace, too-large past 1,024 px, unavailable for a bad font list', () => {
    const fake = fakeCanvas({ left: 0, right: 2000, ascent: 10, descent: 2 });
    const port = createCanvasGlyphRaster({ createCanvas: fake.createCanvas });
    expect(port.rasterize({ ...request, text: ' 　' })).toEqual({ status: 'empty' });
    expect(port.rasterize(request)).toEqual({ status: 'failed', reason: 'too-large' });
    const bad = fakeCanvas({ left: 0, right: 5, ascent: 10, descent: 2 }, { parses: false });
    expect(createCanvasGlyphRaster({ createCanvas: bad.createCanvas }).rasterize(request)).toEqual({
      status: 'failed',
      reason: 'unavailable',
    });
    const none = createCanvasGlyphRaster({
      createCanvas: () => {
        throw new Error('no OffscreenCanvas');
      },
    });
    expect(none.rasterize(request)).toEqual({ status: 'failed', reason: 'unavailable' });
  });

  it('returns empty for a box without ink and does not retry a failed context', () => {
    const ink = fakeCanvas({ left: 0, right: 0, ascent: 0, descent: 0 });
    const port = createCanvasGlyphRaster({ createCanvas: ink.createCanvas });
    expect(port.rasterize({ ...request, text: '\u200d' })).toEqual({ status: 'empty' });
    expect(ink.fills).toEqual([]);
    const createCanvas = vi.fn(() => {
      throw new Error('no OffscreenCanvas');
    });
    const none = createCanvasGlyphRaster({ createCanvas });
    expect(none.rasterize(request)).toEqual({ status: 'failed', reason: 'unavailable' });
    expect(none.rasterize(request)).toEqual({ status: 'failed', reason: 'unavailable' });
    expect(createCanvas).toHaveBeenCalledTimes(1);
  });

  it('keeps ink with a negative left bearing inside the bitmap, and resizes the canvas', () => {
    const fake = fakeCanvas({ left: 6.5, right: 3, ascent: 120, descent: 30 });
    const port = createCanvasGlyphRaster({ createCanvas: fake.createCanvas });
    const result = port.rasterize({ ...request, phaseX: 0 });
    expect(result).toMatchObject({ status: 'ok', left: 9, top: 122, width: 14, height: 154 });
    expect(fake.canvas.height).toBe(154);
    // The resize reset the context, so the font was set again before drawing.
    expect(fake.fills[0]![3]).toBe('16px "Arial", sans-serif');
  });
});
