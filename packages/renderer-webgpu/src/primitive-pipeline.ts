import type { PipelineCacheKey } from './pipeline-cache.js';
import { PRIMITIVE_ANALYTIC_SHADER_KEY } from './primitive-analytic-shader.js';
import { createPrimitiveUnitQuadVertexLayout } from './primitive-unit-geometry.js';

export const PRIMITIVE_PACKET_LAYOUT_KEY = 'p1-packet-v1';
export const PRIMITIVE_UNIT_QUAD_VERTEX_LAYOUT_KEY = 'unit-quad-v1';
export const PRIMITIVE_RENDER_STATE_KEY =
  'premultiplied-source-over/no-depth/no-cull/triangle-list-v1';

export type PrimitiveTargetFormat = 'bgra8unorm' | 'rgba8unorm';

export function primitivePipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: PRIMITIVE_ANALYTIC_SHADER_KEY,
    layoutKey: PRIMITIVE_PACKET_LAYOUT_KEY,
    vertexLayoutKey: PRIMITIVE_UNIT_QUAD_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: PRIMITIVE_RENDER_STATE_KEY,
    sampleCount,
  });
}

export function createPrimitivePipelineDescriptor(
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
): GPURenderPipelineDescriptor {
  return {
    label: `vector-studio/p1-analytic-primitive-${sampleCount}x`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: 'vertexMain',
      buffers: [createPrimitiveUnitQuadVertexLayout()],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragmentMain',
      targets: [
        {
          format: targetFormat,
          blend: {
            color: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
          writeMask: 0xf,
        },
      ],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    multisample: {
      count: sampleCount,
      mask: 0xffffffff,
      alphaToCoverageEnabled: false,
    },
  };
}
