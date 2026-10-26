import type { MeshResourceId } from '@vector-studio/renderer-core';

import type { PipelineCacheKey } from './pipeline-cache.js';
import {
  MESH_FILL_SHADER_KEY,
  MESH_JOINT_FRAGMENT_ENTRY_POINT,
  MESH_JOINT_SHADER_KEY,
  MESH_JOINT_VERTEX_ENTRY_POINT,
} from './mesh-fill-shader.js';
import { MESH_STENCIL_FORMAT, type PrimitiveTargetFormat } from './primitive-pipeline.js';

// The second pipeline of the P3 V3 contract, section f: five read-only storage bindings and one
// uniform, visible to the vertex and fragment stages, and no vertex or index buffer. ST-U7
// addendum, section 4.5: a joint pipeline over the same module, layout and bind group layout,
// with its own shaderKey and entry points, created beside the fill pipeline.

export const MESH_PACKET_LAYOUT_VERSION = 0;
export const MESH_PACKET_LAYOUT_KEY = 'p3-mesh-packet-v0';
export const MESH_VERTEX_LAYOUT_KEY = 'vertex-pulling-v0';
export const MESH_FRAME_SIZE = 32;

/** Required device limits for the mesh pipeline (section f). */
export const MESH_REQUIRED_STORAGE_BUFFERS_PER_STAGE = 5;
export const MESH_REQUIRED_BINDINGS_PER_BIND_GROUP = 6;

export const MESH_RESOURCE_IDS = [
  'meshPositions',
  'meshTriangles',
  'meshFeatureLists',
  'meshFeatures',
  'meshInstances',
  'meshFrame',
] as const satisfies readonly MeshResourceId[];

export const MESH_RESOURCE_STRIDES: Readonly<Record<MeshResourceId, number>> = Object.freeze({
  meshPositions: 8,
  meshTriangles: 32,
  meshFeatureLists: 4,
  meshFeatures: 64,
  meshInstances: 64,
  meshFrame: MESH_FRAME_SIZE,
});

export const MESH_PACKET_BINDINGS: Readonly<Record<MeshResourceId, number>> = Object.freeze({
  meshPositions: 0,
  meshTriangles: 1,
  meshFeatureLists: 2,
  meshFeatures: 3,
  meshInstances: 4,
  meshFrame: 5,
});

const VERTEX_AND_FRAGMENT_VISIBILITY = 0x3;

export function createMeshBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/p3-mesh-packet-layout',
    entries: MESH_RESOURCE_IDS.map((id) => ({
      binding: MESH_PACKET_BINDINGS[id],
      visibility: VERTEX_AND_FRAGMENT_VISIBILITY,
      buffer: { type: id === 'meshFrame' ? ('uniform' as const) : ('read-only-storage' as const) },
    })),
  };
}

/**
 * E17 contract, section 3: the mesh draws' render state. P1's premultiplied source-over and no
 * culling, plus the write-once stencil (E17-K1): a sample is written by the first surviving
 * fragment of a draw, whose per-draw reference then blocks every later fragment of that draw.
 */
export const MESH_RENDER_STATE_KEY =
  'premultiplied-source-over/stencil8-write-once/no-cull/triangle-list-v1';

/** E17 contract, section 3: mesh draws get references 1..MESH_STENCIL_REFERENCES, then a reset. */
export const MESH_STENCIL_REFERENCES = 255;

/** E17-K2: test not-equal to the draw's reference, replace on pass. */
export function meshWriteOnceStencilState(): GPUDepthStencilState {
  const face = {
    compare: 'not-equal',
    failOp: 'keep',
    depthFailOp: 'keep',
    passOp: 'replace',
  } as const;
  return {
    format: MESH_STENCIL_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: 0xff,
    stencilWriteMask: 0xff,
  };
}

/** E17-K2: the reset draw sets every covered sample's stencil to 0. */
export function meshStencilResetState(): GPUDepthStencilState {
  const face = {
    compare: 'always',
    failOp: 'keep',
    depthFailOp: 'keep',
    passOp: 'zero',
  } as const;
  return {
    format: MESH_STENCIL_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: 0xff,
    stencilWriteMask: 0xff,
  };
}

export const MESH_STENCIL_RESET_SHADER_KEY = 'p3-mesh-stencil-reset-v0';

/**
 * E17 contract, section 3: the reset draw's module, a fullscreen triangle with no color output
 * (the pipeline's color write mask is 0). Separate from MESH_FILL_SHADER, whose hash E3 records.
 */
export const MESH_STENCIL_RESET_SHADER = /* wgsl */ `
@vertex
fn meshStencilResetVertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn meshStencilResetFragmentMain() -> @location(0) vec4f {
  return vec4f(0.0);
}
`;

/** E17 contract, section 3: the reset pipeline for a color target (main pass or count pass). */
export function createMeshStencilResetPipelineDescriptor(
  shaderModule: GPUShaderModule,
  targetFormat: GPUTextureFormat,
  sampleCount: 1 | 4,
  label: string,
): GPURenderPipelineDescriptor {
  return {
    label,
    layout: 'auto',
    vertex: { module: shaderModule, entryPoint: 'meshStencilResetVertexMain', buffers: [] },
    fragment: {
      module: shaderModule,
      entryPoint: 'meshStencilResetFragmentMain',
      targets: [{ format: targetFormat, writeMask: 0 }],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    depthStencil: meshStencilResetState(),
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/** The mesh pipelines: V3's fill pipeline and ST-U7's joint fill pipeline. */
export type MeshPipelineKind = 'fill' | 'joint';

export function meshPipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  kind: MeshPipelineKind = 'fill',
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: kind === 'fill' ? MESH_FILL_SHADER_KEY : MESH_JOINT_SHADER_KEY,
    layoutKey: MESH_PACKET_LAYOUT_KEY,
    vertexLayoutKey: MESH_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: MESH_RENDER_STATE_KEY,
    sampleCount,
  });
}

export function createMeshPipelineDescriptor(
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  kind: MeshPipelineKind = 'fill',
): GPURenderPipelineDescriptor {
  const fill = kind === 'fill';
  return {
    label: `vector-studio/p3-mesh-${fill ? 'fill' : 'joint'}-${sampleCount}x`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: fill ? 'meshVertexMain' : MESH_JOINT_VERTEX_ENTRY_POINT,
      buffers: [],
    },
    fragment: {
      module: shaderModule,
      entryPoint: fill ? 'meshFragmentMain' : MESH_JOINT_FRAGMENT_ENTRY_POINT,
      targets: [
        {
          format: targetFormat,
          // P1's premultiplied source-over blend (D2 composition).
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
          writeMask: 0xf,
        },
      ],
    },
    // Cull mode none: winding never discards a triangle.
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    // E17-K2: write-once per draw; the draw's reference is set before it is encoded.
    depthStencil: meshWriteOnceStencilState(),
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/**
 * E17-K2: the stencil reference of the frame's mesh draw with ordinal `ordinal` (0-based, in
 * encoded order), and whether a reset draw precedes it. The main pass and E10's count pass both
 * follow this sequence.
 */
export function meshStencilStep(ordinal: number): Readonly<{ reset: boolean; reference: number }> {
  return {
    reset: ordinal > 0 && ordinal % MESH_STENCIL_REFERENCES === 0,
    reference: (ordinal % MESH_STENCIL_REFERENCES) + 1,
  };
}
