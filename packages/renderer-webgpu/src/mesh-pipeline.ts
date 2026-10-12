import type { MeshResourceId } from '@vector-studio/renderer-core';

import type { PipelineCacheKey } from './pipeline-cache.js';
import { MESH_FILL_SHADER_KEY } from './mesh-fill-shader.js';
import { PRIMITIVE_RENDER_STATE_KEY, type PrimitiveTargetFormat } from './primitive-pipeline.js';

// The second pipeline of the P3 V3 contract, section f: five read-only storage bindings and one
// uniform, visible to the vertex and fragment stages, and no vertex or index buffer.

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

export function meshPipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: MESH_FILL_SHADER_KEY,
    layoutKey: MESH_PACKET_LAYOUT_KEY,
    vertexLayoutKey: MESH_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: PRIMITIVE_RENDER_STATE_KEY,
    sampleCount,
  });
}

export function createMeshPipelineDescriptor(
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
): GPURenderPipelineDescriptor {
  return {
    label: `vector-studio/p3-mesh-fill-${sampleCount}x`,
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: 'meshVertexMain', buffers: [] },
    fragment: {
      module: shaderModule,
      entryPoint: 'meshFragmentMain',
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
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}
