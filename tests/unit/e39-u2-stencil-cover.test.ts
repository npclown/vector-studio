import type {
  FillMesh,
  FillMeshRequest,
  RenderNodeSnapshot,
  SceneClip,
} from '@vector-studio/contracts';
import { ResourceAccounting, type PrimitiveTarget } from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import {
  MESH_COVER_ROLE,
  MESH_STRIDES,
  MESH_TRIANGLE_NO_DISCARD,
} from '../../packages/renderer-core/src/path-mesh-packet.js';
import { pathMeshNoticeDiagnostic } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import {
  createMeshPipelineDescriptor,
  createMeshStencilPipelineDescriptor,
  MESH_PACKET_LAYOUT_KEY,
  MESH_PACKET_LAYOUT_VERSION,
  meshCoverStencilState,
  meshPipelineKey,
  meshStencilPassState,
  meshStencilPipelineKey,
  MeshStencilSequence,
  meshStencilStep,
} from '../../packages/renderer-webgpu/src/mesh-pipeline.js';
import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';
import { createStrokeHarness, ScriptedStrokeMeshPort } from '../support/st-u6-stroke-harness.js';
import {
  createPathHarness,
  okResult,
  pathNode,
  ScriptedFillMeshPort,
  squareMesh,
} from '../support/v3a-path-harness.js';

// E39 contract (docs/plans/d9-e39-gpu-stencil-path-contract.md), unit U2, acceptance E39-A5 for
// plain draws: the stencil pass and cover states (R1, R2), the cover quad's records (R3), no
// discard (R4), the E17 sequence alongside (R5), the packet layout version 1 and the pipeline
// set (R8) and the count pass replay (R9), with fake device seams and a recording pass.

type PassRecord = {
  descriptor: GPURenderPassDescriptor;
  calls: (readonly [string, ...unknown[]])[];
};

function fixture() {
  const passes: PassRecord[] = [];
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const writes: { label: string; offset: number; data: Uint8Array }[] = [];
  const device = {
    limits: {
      minStorageBufferOffsetAlignment: 256,
      minUniformBufferOffsetAlignment: 256,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxUniformBufferBindingSize: 65536,
      maxBufferSize: 256 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 8,
      maxUniformBuffersPerShaderStage: 12,
      maxBindingsPerBindGroup: 1000,
      maxBindGroups: 4,
    },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({
      label: descriptor.label,
      destroy: vi.fn(),
      mapAsync: vi.fn(() => new Promise<void>(() => {})),
    })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({
      label: descriptor.label,
    })),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ label: descriptor.label })),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
      descriptors.push(descriptor);
      return Promise.resolve({ label: descriptor.label ?? '' });
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
      label: descriptor.label,
      createView: vi.fn(() => ({ texture: descriptor.label })),
      destroy: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
        const record: PassRecord = { descriptor, calls: [] };
        passes.push(record);
        const log =
          (name: string) =>
          (...args: unknown[]) =>
            record.calls.push([name, ...args]);
        return {
          setPipeline: (pipeline: { label: string }) =>
            record.calls.push(['setPipeline', pipeline.label]),
          setBindGroup: log('setBindGroup'),
          setVertexBuffer: log('setVertexBuffer'),
          setIndexBuffer: log('setIndexBuffer'),
          setStencilReference: log('setStencilReference'),
          setViewport: log('setViewport'),
          drawIndexed: log('drawIndexed'),
          draw: log('draw'),
          end: log('end'),
        };
      }),
      copyTextureToBuffer: vi.fn(),
      copyTextureToTexture: vi.fn(),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      writeBuffer: vi.fn(
        (
          buffer: { label: string },
          offset: number,
          data: ArrayBufferView,
          start?: number,
          size?: number,
        ) => {
          const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const from: number = start ?? 0;
          const to: number = size === undefined ? bytes.length : from + size;
          writes.push({
            label: buffer.label,
            offset,
            data: bytes.slice(from, to),
          });
        },
      ),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => new Promise<void>(() => {})),
    },
  } as unknown as GPUDevice;
  const context = {
    native: { getCurrentTexture: () => ({ createView: () => ({ texture: 'presentation' }) }) },
    configure: vi.fn(),
    unconfigure: vi.fn(),
  } as unknown as WebGpuCanvasContextPort;
  return { device, context, passes, descriptors, writes };
}

async function scene(f: ReturnType<typeof fixture>, sampleCount: 1 | 4 = 4, variants = false) {
  const creation = createNativePrimitiveSceneCreation(
    f.device,
    f.context,
    'bgra8unorm',
    1,
    new ResourceAccounting(),
    {
      meshPipeline: true,
      countPass: true,
      sampleCount,
      ...(variants ? { clipPipeline: true, paintPipeline: true, layerPipeline: true } : {}),
    },
  );
  const { scene: s } = await creation.result;
  const target: PrimitiveTarget = {
    generation: 1,
    surfaceRevision: 1,
    width: 640,
    height: 360,
    devicePixelRatio: 1,
    sampleCount: s.sampleCount,
    targetFormat: 'bgra8unorm',
  };
  s.setTarget(target);
  return { scene: s, creation, target };
}

/** A fan over the square [x, x+10] x [0, 10] from its first corner, as K1 builds it. */
function windingMesh(
  x: number,
  coverage: 'winding' | 'union' = 'winding',
  servedExponent?: number,
): FillMesh {
  return {
    positions: Float64Array.from([x, 0, x + 10, 0, x + 10, 10, x, 10]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    boundaryEdges: new Uint32Array(0),
    bounds: { minX: x, minY: 0, maxX: x + 10, maxY: 10 },
    coverage,
    ...(servedExponent === undefined ? {} : { servedExponent }),
  };
}

/**
 * A port serving a partition square for tags below 100 and a winding (or, from 200, a union)
 * fan for the others; a tag from 300 is a winding fan served one exponent coarser.
 */
function e39Port(): ScriptedFillMeshPort {
  return new ScriptedFillMeshPort({
    request: (request: FillMeshRequest, tag: number) => {
      if (tag < 100) return okResult(request, squareMesh());
      if (tag >= 300) {
        return okResult(request, windingMesh(tag, 'winding', request.toleranceExponent + 1));
      }
      return okResult(
        request,
        windingMesh(tag, tag >= 200 ? 'union' : 'winding', request.toleranceExponent),
      );
    },
  });
}

describe('E39-A5 pipeline states and keys (R1, R2, R8)', () => {
  const module = {} as GPUShaderModule;
  const layout = {} as GPUPipelineLayout;

  it('E39-R1: the stencil pass writes no color and counts or marks with compare always', () => {
    const winding = createMeshStencilPipelineDescriptor(module, layout, 'bgra8unorm', 4, 'winding');
    expect(winding.fragment!.targets).toEqual([{ format: 'bgra8unorm', writeMask: 0 }]);
    expect(winding.fragment!.entryPoint).toBe('meshStencilFragmentMain');
    expect(winding.vertex.entryPoint).toBe('meshVertexMain');
    expect(winding.primitive).toEqual({
      topology: 'triangle-list',
      frontFace: 'ccw',
      cullMode: 'none',
    });
    expect(meshStencilPassState('winding')).toEqual({
      format: 'stencil8',
      depthWriteEnabled: false,
      depthCompare: 'always',
      stencilFront: {
        compare: 'always',
        failOp: 'keep',
        depthFailOp: 'keep',
        passOp: 'increment-wrap',
      },
      stencilBack: {
        compare: 'always',
        failOp: 'keep',
        depthFailOp: 'keep',
        passOp: 'decrement-wrap',
      },
      stencilReadMask: 0xff,
      stencilWriteMask: 0xff,
    });
    expect(meshStencilPassState('union')).toMatchObject({
      stencilFront: { compare: 'always', passOp: 'replace' },
      stencilBack: { compare: 'always', passOp: 'replace' },
      stencilWriteMask: 0xff,
    });
  });

  it('E39-R2: covers test not-equal 0 (read mask 0xff or 0x01) and zero on pass and fail', () => {
    for (const [rule, readMask] of [
      ['nonzero', 0xff],
      ['evenodd', 0x01],
    ] as const) {
      const face = { compare: 'not-equal', failOp: 'zero', depthFailOp: 'zero', passOp: 'zero' };
      expect(meshCoverStencilState(rule)).toEqual({
        format: 'stencil8',
        depthWriteEnabled: false,
        depthCompare: 'always',
        stencilFront: face,
        stencilBack: face,
        stencilReadMask: readMask,
        stencilWriteMask: 0xff,
      });
      const kind = rule === 'nonzero' ? 'cover-nonzero' : 'cover-evenodd';
      const cover = createMeshPipelineDescriptor(module, layout, 'bgra8unorm', 4, kind);
      expect(cover.depthStencil).toEqual(meshCoverStencilState(rule));
      expect(cover.vertex.entryPoint).toBe('meshVertexMain');
      expect(cover.fragment!.entryPoint).toBe('meshFragmentMain');
      expect(cover.fragment!.targets[0]).toMatchObject({ writeMask: 0xf });
    }
  });

  it('E39-R8: packet layout v1 and distinct cache keys per state', () => {
    expect(MESH_PACKET_LAYOUT_VERSION).toBe(1);
    expect(MESH_PACKET_LAYOUT_KEY).toBe('p3-mesh-packet-v1');
    const keys = [
      meshPipelineKey('bgra8unorm', 4, 'fill'),
      meshPipelineKey('bgra8unorm', 4, 'joint'),
      meshPipelineKey('bgra8unorm', 4, 'cover-nonzero'),
      meshPipelineKey('bgra8unorm', 4, 'cover-evenodd'),
      meshStencilPipelineKey('bgra8unorm', 4, 'winding'),
      meshStencilPipelineKey('bgra8unorm', 4, 'union'),
    ].map((key) => JSON.stringify(key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(meshPipelineKey('bgra8unorm', 4, 'cover-evenodd').renderStateKey).toBe(
      'premultiplied-source-over/stencil8-cover-evenodd/no-cull/triangle-list-v1',
    );
    expect(meshStencilPipelineKey('bgra8unorm', 4, 'winding').renderStateKey).toBe(
      'no-color/stencil8-stencil-winding/no-cull/triangle-list-v1',
    );
  });

  it('E39-R3, R4: the shader draws cover triangles from the box of four corners and never discards a flagged triangle', () => {
    expect(MESH_FILL_SHADER).toContain('if (triangle.role == COVER_ROLE)');
    expect(MESH_FILL_SHADER).toContain('const COVER_MARGIN_PX: f32 = 1.0;');
    expect(MESH_FILL_SHADER).toContain('if (alpha == 0.0 && triangle.padding1 != NO_DISCARD) {');
    expect(MESH_FILL_SHADER).toContain(
      'let roleConstant = select(1.0, 0.0, triangle.role == EXTERIOR_ROLE);',
    );
    expect(MESH_COVER_ROLE).toBe(2);
    expect(MESH_TRIANGLE_NO_DISCARD).toBe(1);
  });

  it('E39-R5: winding draws take no E17 ordinal; one reset follows partition writes', () => {
    const sequence = new MeshStencilSequence();
    expect(sequence.winding()).toBe(false);
    expect(sequence.partition()).toEqual(meshStencilStep(0));
    expect(sequence.partition()).toEqual(meshStencilStep(1));
    expect(sequence.winding()).toBe(true);
    expect(sequence.winding()).toBe(false);
    expect(sequence.partition()).toEqual(meshStencilStep(2));
    expect(sequence.winding()).toBe(true);
  });
});

describe('E39-A5 packet (R3, R8, K4 notice)', () => {
  it('a winding draw packs its fan, two cover triangles and four cover corners', () => {
    const h = createPathHarness({
      port: e39Port(),
      nodes: [pathNode('w', 120, { fillRule: 'evenodd' })],
    });
    const packet = h.source.prepare({
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: 4,
      targetFormat: 'bgra8unorm',
    })!;
    const part = packet.mesh!;
    expect(part.layoutVersion).toBe(1);
    expect(part.draws).toHaveLength(1);
    const draw = part.draws[0]!;
    expect(draw).toMatchObject({ coverage: 'winding', fillRule: 'evenodd', triangleCount: 4 });
    const bytes = (id: string) => {
      const write = part.writes.find((candidate) => candidate.resourceId === id)!;
      return new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
    };
    const triangles = bytes('meshTriangles');
    const record = (index: number) =>
      Array.from({ length: 8 }, (_, word) =>
        triangles.getUint32(
          (draw.firstTriangle + index) * MESH_STRIDES.meshTriangles + 4 * word,
          true,
        ),
      );
    expect(record(0)).toEqual([0, 1, 2, 0, 0, 0, 0, 1]);
    expect(record(1)).toEqual([0, 2, 3, 0, 0, 0, 0, 1]);
    expect(record(2)).toEqual([4, 0, 0, 0, 0, 2, 0, 1]);
    expect(record(3)).toEqual([4, 0, 0, 0, 0, 2, 1, 1]);
    // The corners follow the four port vertices: the bounds' corners less the midpoint.
    const positions = bytes('meshPositions');
    const corners = Array.from({ length: 8 }, (_, lane) =>
      positions.getFloat32(32 + 4 * lane, true),
    );
    expect(corners).toEqual([-5, -5, 5, -5, 5, 5, -5, 5]);
  });

  it('a coarser served exponent queues one path-coarsened notice', () => {
    const h = createPathHarness({ port: e39Port(), nodes: [pathNode('c', 320)] });
    const first = h.prepare();
    const notices = first.notices.filter((notice) => notice.failureCode === 'path-coarsened');
    expect(notices).toHaveLength(1);
    expect(first.draws).toHaveLength(1);
    expect(pathMeshNoticeDiagnostic(notices[0]!, 1).message).toBe(
      'Path c is drawn at a coarser tolerance (renderer path-coarsened).',
    );
    expect(h.prepare().notices).toHaveLength(0);
  });
});

describe('E39-A5 encoding (R1, R2, R5, R9)', () => {
  const nodes = [
    pathNode('p0', 10),
    pathNode('w1', 120),
    pathNode('m2', 130, { transform: [-1, 0, 0, 1, 300, 0] }),
    pathNode('e3', 140, { fillRule: 'evenodd' }),
    pathNode('u4', 250),
    pathNode('p5', 20),
    pathNode('w6', 160),
  ];

  async function encode(sampleCount: 1 | 4) {
    const f = fixture();
    const { scene: s, creation, target } = await scene(f, sampleCount);
    const h = createPathHarness({ port: e39Port(), nodes });
    const packet = h.source.prepare(target)!;
    const settled = new Promise<void>((resolve) => {
      s.captureNextSubmissionForTesting!({
        counts: true,
        encoded: () => resolve(),
        resolve: () => undefined,
        reject: () => undefined,
      });
    });
    expect(s.submitPrimitivePacket(packet).status).toBe('submitted');
    await settled;
    return { f, packet, creation };
  }

  for (const sampleCount of [4, 1] as const) {
    it(`E39-A5: the main pass and the count pass encode R1 then R2 per winding draw (${sampleCount}x)`, async () => {
      const { f, packet, creation } = await encode(sampleCount);
      const draws = packet.mesh!.draws;
      expect(draws.map((draw) => draw.coverage ?? 'partition')).toEqual([
        'partition',
        'winding',
        'winding',
        'winding',
        'union',
        'partition',
        'winding',
      ]);
      const x = `${sampleCount}x`;
      const [main, count] = f.passes;
      const meshCalls = (pass: PassRecord, labels: Record<string, string>) =>
        pass.calls.flatMap((call): unknown[] => {
          if (call[0] === 'setPipeline') {
            const name = labels[call[1] as string];
            return name === undefined ? [] : [name];
          }
          if (call[0] === 'setStencilReference') return [`ref ${String(call[1])}`];
          if (call[0] === 'draw') return [call.slice(1)];
          return [];
        });
      const tri = (index: number) => [
        3 * (draws[index]!.triangleCount - 2),
        1,
        3 * draws[index]!.firstTriangle,
        draws[index]!.instance,
      ];
      const quad = (index: number) => [
        6,
        1,
        3 * (draws[index]!.firstTriangle + draws[index]!.triangleCount - 2),
        draws[index]!.instance,
      ];
      const whole = (index: number) => [
        3 * draws[index]!.triangleCount,
        1,
        3 * draws[index]!.firstTriangle,
        draws[index]!.instance,
      ];
      const expected = (
        prefix: Readonly<{ fill: string; reset: string; nonzero: string; evenodd: string }>,
      ) => [
        prefix.fill,
        'ref 1',
        whole(0),
        prefix.reset,
        [3],
        'stencil-winding',
        'ref 0',
        tri(1),
        prefix.nonzero,
        'ref 0',
        quad(1),
        'stencil-winding',
        'ref 0',
        tri(2),
        prefix.nonzero,
        'ref 0',
        quad(2),
        'stencil-winding',
        'ref 0',
        tri(3),
        prefix.evenodd,
        'ref 0',
        quad(3),
        'stencil-union',
        'ref 1',
        tri(4),
        prefix.nonzero,
        'ref 0',
        quad(4),
        prefix.fill,
        'ref 2',
        whole(5),
        prefix.reset,
        [3],
        'stencil-winding',
        'ref 0',
        tri(6),
        prefix.nonzero,
        'ref 0',
        quad(6),
      ];
      const stencilLabels = (format: string) => ({
        [`vector-studio/e39-mesh-stencil-winding-${format}-${x}`]: 'stencil-winding',
        [`vector-studio/e39-mesh-stencil-union-${format}-${x}`]: 'stencil-union',
      });
      expect(
        meshCalls(main!, {
          ...stencilLabels('bgra8unorm'),
          [`vector-studio/p3-mesh-fill-${x}`]: 'fill',
          [`vector-studio/p3-mesh-stencil-reset-${x}`]: 'reset',
          [`vector-studio/p3-mesh-cover-nonzero-${x}`]: 'nonzero',
          [`vector-studio/p3-mesh-cover-evenodd-${x}`]: 'evenodd',
        }),
      ).toEqual(expected({ fill: 'fill', reset: 'reset', nonzero: 'nonzero', evenodd: 'evenodd' }));
      expect(count!.descriptor.label).toBe('vector-studio/e10-count-pass');
      expect(
        meshCalls(count!, {
          ...stencilLabels('rgba16float'),
          [`vector-studio/e10-count-fill-${x}`]: 'fill',
          [`vector-studio/e10-count-stencil-reset-${x}`]: 'reset',
          [`vector-studio/e39-count-cover-nonzero-${x}`]: 'nonzero',
          [`vector-studio/e39-count-cover-evenodd-${x}`]: 'evenodd',
        }),
      ).toEqual(expected({ fill: 'fill', reset: 'reset', nonzero: 'nonzero', evenodd: 'evenodd' }));
      // The count covers write 1 additively with no discard under the cover states.
      const countCover = f.descriptors.find(
        (d) => d.label === `vector-studio/e39-count-cover-evenodd-${x}`,
      )!;
      expect(countCover.depthStencil).toEqual(meshCoverStencilState('evenodd'));
      expect(countCover.fragment!.entryPoint).toBe('meshCountFragmentMain');
      creation.dispose();
    });
  }

  it('E39-R8: the generation creates the stencil and cover pipelines with the mesh pipelines', async () => {
    const f = fixture();
    const { creation } = await scene(f, 4, true);
    const labels = f.descriptors.map((d) => d.label);
    for (const label of [
      'vector-studio/e39-mesh-stencil-winding-bgra8unorm-4x',
      'vector-studio/e39-mesh-stencil-union-bgra8unorm-4x',
      'vector-studio/p3-mesh-cover-nonzero-4x',
      'vector-studio/p3-mesh-cover-evenodd-4x',
      'vector-studio/p3-mesh-cover-joint-both-nonzero-4x',
      'vector-studio/p3-mesh-cover-joint-both-evenodd-4x',
      'vector-studio/p3-mesh-cover-joint-fill-nonzero-4x',
      'vector-studio/p3-mesh-cover-joint-fill-evenodd-4x',
      'vector-studio/p3-mesh-cover-joint-stroke-4x',
      'vector-studio/p3-mesh-cover-nonzero-4x+clip-v0',
      'vector-studio/p3-mesh-cover-evenodd-4x+clip-v0',
      'vector-studio/p3-mesh-cover-joint-both-nonzero-4x+clip-v0',
      'vector-studio/p3-mesh-cover-joint-both-evenodd-4x+clip-v0',
      'vector-studio/p3-mesh-cover-joint-fill-nonzero-4x+clip-v0',
      'vector-studio/p3-mesh-cover-joint-fill-evenodd-4x+clip-v0',
      'vector-studio/p3-mesh-cover-joint-stroke-4x+clip-v0',
      'vector-studio/e39-mesh-stencil-winding-r8unorm-4x',
      'vector-studio/p3-mesh-cover-nonzero-4x+mask-v0',
      'vector-studio/p3-mesh-cover-evenodd-4x+mask-v0',
      'vector-studio/e39-count-cover-nonzero-4x',
      'vector-studio/e39-count-cover-evenodd-4x',
      'vector-studio/p3-mesh-cover-nonzero-4x+paint-v1',
      'vector-studio/p3-mesh-cover-evenodd-4x+paint-v1+clip-v0',
      'vector-studio/p3-mesh-cover-joint-both-nonzero-4x+paint-v1+clip-v0',
      'vector-studio/p3-mesh-cover-joint-both-evenodd-4x+paint-v1+clip-v0',
      'vector-studio/p3-mesh-cover-joint-fill-nonzero-4x+paint-v1+clip-v0',
      'vector-studio/p3-mesh-cover-joint-fill-evenodd-4x+paint-v1+clip-v0',
      'vector-studio/p3-mesh-cover-joint-stroke-4x+paint-v1+clip-v0',
      'vector-studio/p3-mesh-cover-nonzero-4x+layer-v0',
      'vector-studio/p3-mesh-cover-evenodd-4x+paint-v1+clip-v0+layer-v0',
      'vector-studio/p3-mesh-cover-joint-both-nonzero-4x+paint-v1+clip-v0+layer-v0',
      'vector-studio/p3-mesh-cover-joint-both-evenodd-4x+paint-v1+clip-v0+layer-v0',
      'vector-studio/p3-mesh-cover-joint-fill-nonzero-4x+paint-v1+clip-v0+layer-v0',
      'vector-studio/p3-mesh-cover-joint-fill-evenodd-4x+paint-v1+clip-v0+layer-v0',
      'vector-studio/p3-mesh-cover-joint-stroke-4x+paint-v1+clip-v0+layer-v0',
    ]) {
      expect(labels).toContain(label);
    }
    creation.dispose();
  });
});

describe('E39-A5 layer and mask tile passes (R7)', () => {
  const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
  const container = (
    id: string,
    opacity: number,
    children: readonly string[],
    clip: SceneClip | null,
  ): RenderNodeSnapshot => ({
    id,
    parentId: null,
    transform: [...IDENTITY],
    visible: true,
    opacity,
    kind: 'container',
    clip,
    children,
  });
  const meshCalls = (calls: readonly (readonly unknown[])[]) =>
    calls.flatMap((call): unknown[] => {
      if (call[0] === 'beginRenderPass') return [`pass ${String(call[1])}`];
      if (call[0] === 'setPipeline') return [String(call[1])];
      if (call[0] === 'setStencilReference') return [`ref ${String(call[1])}`];
      if (call[0] === 'draw') return [call.slice(1)];
      return [];
    });

  it('E39-R7: a layer tile pass draws a winding path with its stencil pass and the layer cover', async () => {
    const fixture = nativeFixture();
    const {
      scene: s,
      creation,
      target,
    } = await nativeScene(fixture, {
      meshPipeline: true,
      clipPipeline: true,
      paintPipeline: true,
      layerPipeline: true,
    });
    const h = createStrokeHarness({
      fillPort: e39Port(),
      strokePort: new ScriptedStrokeMeshPort(),
      clips: 'rect',
      groupOpacity: 'supported',
      nodes: [
        container('g', 0.5, ['p', 'w'], null),
        pathNode('p', 10, { parentId: 'g' }),
        pathNode('w', 140, { parentId: 'g', fillRule: 'evenodd' }),
      ],
    });
    const packet = h.source.prepare(target)!;
    const layer = packet.layers!.layers[0]!;
    const [partition, winding] = layer.meshDraws;
    expect(partition!.coverage).toBeUndefined();
    expect(winding).toMatchObject({ coverage: 'winding', fillRule: 'evenodd' });
    submitted(s.submitPrimitivePacket(packet));
    const calls = meshCalls(fixture.calls);
    const start = calls.indexOf('pass vector-studio/layer-pass/0');
    expect(start).toBeGreaterThanOrEqual(0);
    const fan = winding!.triangleCount - 2;
    expect(calls.slice(start + 1, start + 13)).toEqual([
      'vector-studio/p3-mesh-fill-4x+layer-v0',
      'ref 1',
      [3 * partition!.triangleCount, 1, 3 * partition!.firstTriangle, partition!.instance],
      'vector-studio/p3-mesh-stencil-reset-4x',
      [3],
      'vector-studio/e39-mesh-stencil-winding-bgra8unorm-4x',
      'ref 0',
      [3 * fan, 1, 3 * winding!.firstTriangle, winding!.instance],
      'vector-studio/p3-mesh-cover-evenodd-4x+layer-v0',
      'ref 0',
      [6, 1, 3 * (winding!.firstTriangle + fan), winding!.instance],
      calls[start + 12],
    ]);
    creation.dispose();
  });

  it('E39-R7: a mask tile pass draws a winding source with its stencil pass and the mask cover', async () => {
    const fixture = nativeFixture();
    const { scene: s, creation, target } = await nativeScene(fixture);
    const h = createStrokeHarness({
      fillPort: e39Port(),
      strokePort: new ScriptedStrokeMeshPort(),
      clips: 'supported',
      nodes: [
        container('m', 1, ['s', 'a'], { kind: 'mask' }),
        pathNode('s', 150, { parentId: 'm', fill: null }),
        pathNode('a', 152, { parentId: 'm' }),
      ],
    });
    const packet = h.source.prepare(target)!;
    const level = packet.clip!.masks[0]!;
    if (level.source.kind !== 'mesh') throw new Error('expected a mesh source');
    const draw = level.source.draw!;
    expect(draw).toMatchObject({ coverage: 'winding', fillRule: 'nonzero' });
    submitted(s.submitPrimitivePacket(packet));
    const fan = draw.triangleCount - 2;
    expect(meshCalls(fixture.calls).slice(0, 8)).toEqual([
      'pass vector-studio/mask-pass/m',
      'vector-studio/e39-mesh-stencil-winding-r8unorm-4x',
      'ref 0',
      [3 * fan, 1, 3 * draw.firstTriangle, draw.instance],
      'vector-studio/p3-mesh-cover-nonzero-4x+mask-v0',
      [6, 1, 3 * (draw.firstTriangle + fan), draw.instance],
      expect.any(String),
      expect.anything(),
    ]);
    creation.dispose();
  });
});
