import type { PipelineCacheKey } from './pipeline-cache.js';
import { PRIMITIVE_ANALYTIC_SHADER_KEY } from './primitive-analytic-shader.js';
import { createPrimitiveUnitQuadVertexLayout } from './primitive-unit-geometry.js';

export const PRIMITIVE_PACKET_LAYOUT_KEY = 'p1-packet-v1';
export const PRIMITIVE_UNIT_QUAD_VERTEX_LAYOUT_KEY = 'unit-quad-v1';
export const PRIMITIVE_RENDER_STATE_KEY =
  'premultiplied-source-over/no-depth/no-cull/triangle-list-v1';
/**
 * E17 contract, section 3: the analytic pipeline of a mesh generation, whose main pass carries
 * the write-once stencil attachment. Stencil is read and written by mesh draws only.
 */
export const PRIMITIVE_STENCIL_RENDER_STATE_KEY =
  'premultiplied-source-over/stencil8-keep/no-cull/triangle-list-v1';

/** E17 contract, section 3: the main pass's depth-stencil format in a mesh generation. */
export const MESH_STENCIL_FORMAT = 'stencil8';

/** E17 contract, section 3: a draw that neither tests nor writes the stencil. */
export function stencilKeepState(): GPUDepthStencilState {
  const face = {
    compare: 'always',
    failOp: 'keep',
    depthFailOp: 'keep',
    passOp: 'keep',
  } as const;
  return {
    format: MESH_STENCIL_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: 0xff,
    stencilWriteMask: 0,
  };
}

export type PrimitiveTargetFormat = 'bgra8unorm' | 'rgba8unorm';

export function primitivePipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil = false,
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: PRIMITIVE_ANALYTIC_SHADER_KEY,
    layoutKey: PRIMITIVE_PACKET_LAYOUT_KEY,
    vertexLayoutKey: PRIMITIVE_UNIT_QUAD_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: stencil ? PRIMITIVE_STENCIL_RENDER_STATE_KEY : PRIMITIVE_RENDER_STATE_KEY,
    sampleCount,
  });
}

/** With `stencil`, the E17 analytic pipeline of a mesh generation; otherwise P1's, unchanged. */
export function createPrimitivePipelineDescriptor(
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil = false,
): GPURenderPipelineDescriptor {
  return {
    label: `vector-studio/p1-analytic-primitive-${stencil ? 'stencil-' : ''}${sampleCount}x`,
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
    ...(stencil ? { depthStencil: stencilKeepState() } : {}),
    multisample: {
      count: sampleCount,
      mask: 0xffffffff,
      alphaToCoverageEnabled: false,
    },
  };
}
