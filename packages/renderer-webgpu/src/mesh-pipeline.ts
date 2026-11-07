import type { MeshResourceId } from '@vector-studio/renderer-core';

import type { PipelineCacheKey } from './pipeline-cache.js';
import {
  MESH_FILL_SHADER_KEY,
  MESH_JOINT_COVER_FRAGMENT_ENTRY_POINT,
  MESH_JOINT_FRAGMENT_ENTRY_POINT,
  MESH_JOINT_SHADER_KEY,
  MESH_JOINT_VERTEX_ENTRY_POINT,
} from './mesh-fill-shader.js';
import { MESH_STENCIL_FORMAT, type PrimitiveTargetFormat } from './primitive-pipeline.js';

// The second pipeline of the P3 V3 contract, section f: five read-only storage bindings and one
// uniform, visible to the vertex and fragment stages, and no vertex or index buffer. ST-U7
// addendum, section 4.5: a joint pipeline over the same module, layout and bind group layout,
// with its own shaderKey and entry points, created beside the fill pipeline.

/** E39-R8: layout version 1, the draws' coverage. */
export const MESH_PACKET_LAYOUT_VERSION = 1;
export const MESH_PACKET_LAYOUT_KEY = 'p3-mesh-packet-v1';
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

/**
 * E39-R2: the cover pass's stencil test. Pass and fail both zero the sample (write mask 0xff),
 * so every sample the stencil pass touched is 0 again after the cover, and each sample is
 * painted at most once. Nonzero: not-equal to reference 0 under read mask 0xff. Even-odd: the
 * same under read mask 0x01. A union (stroke) mesh's samples hold 0 or 1, so it uses the nonzero
 * cover (equal to 1 under 0xff, as section 3's table states it, passes the same samples).
 */
export type MeshCoverRule = 'nonzero' | 'evenodd';

export function meshCoverStencilState(rule: MeshCoverRule): GPUDepthStencilState {
  const face = {
    compare: 'not-equal',
    failOp: 'zero',
    depthFailOp: 'zero',
    passOp: 'zero',
  } as const;
  return {
    format: MESH_STENCIL_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: rule === 'nonzero' ? 0xff : 0x01,
    stencilWriteMask: 0xff,
  };
}

/**
 * E39-R1: the stencil pass of a winding mesh (fill) or a union mesh (stroke). E39-R6: a joint
 * path's stroke marks bit 7 and its fill counts in the low 7 bits.
 */
export type MeshStencilKind = 'winding' | 'union' | 'joint-stroke' | 'joint-fill';

/** Every stencil pass kind, for creation and eviction. */
export const MESH_STENCIL_KINDS: readonly MeshStencilKind[] = Object.freeze([
  'winding',
  'union',
  'joint-stroke',
  'joint-fill',
]);

/** E39-R6: the joint stroke's stencil bit; the fill's winding count is the low 7 bits. */
export const MESH_JOINT_STROKE_BIT = 0x80;
const MESH_JOINT_COUNT_MASK = 0x7f;

/**
 * E39-R6: a joint path's covers, in encoded order after its two stencil passes:
 * - `joint-both-<rule>`, over the fill's quad: where the stroke and the fill both hold, the
 *   ST-U7 joint fill colour `o · f · (1 − s.a) / (1 − o · s.a)`; it clears the low 7 bits and
 *   keeps the stroke bit (fail keeps);
 * - `joint-fill-<rule>`, over the fill's quad: the rest of the fill, `o · f`; pass and fail
 *   clear the low 7 bits;
 * - `joint-stroke`, over the stroke's quad: `o · s` wherever the stroke bit is set, over what
 *   the first cover painted, so stroke over fill takes the opacity once; pass and fail zero.
 */
export type MeshJointCover =
  | 'joint-both-nonzero'
  | 'joint-both-evenodd'
  | 'joint-fill-nonzero'
  | 'joint-fill-evenodd'
  | 'joint-stroke';

export const MESH_JOINT_COVERS: readonly MeshJointCover[] = Object.freeze([
  'joint-both-nonzero',
  'joint-both-evenodd',
  'joint-fill-nonzero',
  'joint-fill-evenodd',
  'joint-stroke',
]);

/** E39-R6: a joint cover's stencil test and its reference. */
export function meshJointCoverStencilState(cover: MeshJointCover): GPUDepthStencilState {
  const test = {
    'joint-both-nonzero': { compare: 'less', readMask: 0xff, keep: true, writeMask: 0x7f },
    'joint-both-evenodd': { compare: 'equal', readMask: 0x81, keep: true, writeMask: 0x7f },
    'joint-fill-nonzero': {
      compare: 'not-equal',
      readMask: MESH_JOINT_COUNT_MASK,
      keep: false,
      writeMask: MESH_JOINT_COUNT_MASK,
    },
    'joint-fill-evenodd': {
      compare: 'equal',
      readMask: 0x01,
      keep: false,
      writeMask: MESH_JOINT_COUNT_MASK,
    },
    'joint-stroke': {
      compare: 'equal',
      readMask: MESH_JOINT_STROKE_BIT,
      keep: false,
      writeMask: 0xff,
    },
  } as const satisfies Record<
    MeshJointCover,
    { compare: GPUCompareFunction; readMask: number; keep: boolean; writeMask: number }
  >;
  const { compare, readMask, keep, writeMask } = test[cover];
  const face = {
    compare,
    failOp: keep ? 'keep' : 'zero',
    depthFailOp: keep ? 'keep' : 'zero',
    passOp: 'zero',
  } as const;
  return {
    format: MESH_STENCIL_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: readMask,
    stencilWriteMask: writeMask,
  };
}

/** E39-R6: the reference of a joint cover. */
export function meshJointCoverReference(cover: MeshJointCover): number {
  switch (cover) {
    case 'joint-both-nonzero':
    case 'joint-stroke':
      return MESH_JOINT_STROKE_BIT;
    case 'joint-both-evenodd':
      return MESH_JOINT_STROKE_BIT | 1;
    case 'joint-fill-nonzero':
      return 0;
    case 'joint-fill-evenodd':
      return 1;
  }
}

/**
 * E39-R6: the five steps of a joint path (a winding fill and its union stroke at 0 < o < 1),
 * each on the fill's or the stroke's draw: the stencil passes, then the covers.
 */
export type MeshJointStep = Readonly<
  | { stage: 'stencil'; kind: 'joint-stroke' | 'joint-fill'; draw: 'fill' | 'stroke' }
  | { stage: 'cover'; cover: MeshJointCover; draw: 'fill' | 'stroke' }
>;

/** A mesh draw's range for E39-R6's encoding: its instance and its variant's triangles. */
export type MeshJointDrawRange = Readonly<{
  instance: number;
  firstTriangle: number;
  triangleCount: number;
}>;

/**
 * E39-R6: encodes a joint path's five steps in one pass. `stencil` and `cover` give the pass's
 * pipelines; `bindCover` runs after each cover pipeline is set (the pass's other bind groups).
 * Each draw's last two triangle records are its cover quad (E39-R3).
 */
export function encodeMeshJoint(
  pass: GPURenderPassEncoder,
  fill: MeshJointDrawRange,
  stroke: MeshJointDrawRange,
  rule: MeshCoverRule,
  stencil: (kind: 'joint-stroke' | 'joint-fill') => GPURenderPipeline,
  cover: (cover: MeshJointCover) => GPURenderPipeline,
  bindCover: () => void = () => {},
): void {
  for (const step of meshJointSteps(rule)) {
    const draw = step.draw === 'fill' ? fill : stroke;
    const stencilTriangles = draw.triangleCount - 2;
    if (step.stage === 'stencil') {
      pass.setPipeline(stencil(step.kind));
      pass.setStencilReference(meshStencilPassReference(step.kind));
      pass.draw(3 * stencilTriangles, 1, 3 * draw.firstTriangle, draw.instance);
    } else {
      pass.setPipeline(cover(step.cover));
      bindCover();
      pass.setStencilReference(meshJointCoverReference(step.cover));
      pass.draw(6, 1, 3 * (draw.firstTriangle + stencilTriangles), draw.instance);
    }
  }
}

export function meshJointSteps(rule: MeshCoverRule): readonly MeshJointStep[] {
  return [
    { stage: 'stencil', kind: 'joint-stroke', draw: 'stroke' },
    { stage: 'stencil', kind: 'joint-fill', draw: 'fill' },
    { stage: 'cover', cover: `joint-both-${rule}`, draw: 'fill' },
    { stage: 'cover', cover: `joint-fill-${rule}`, draw: 'fill' },
    { stage: 'cover', cover: 'joint-stroke', draw: 'stroke' },
  ];
}

/**
 * E39-R1: compare always, no color writes. A winding mesh counts front faces up and back faces
 * down (wrapping); a union mesh replaces with the draw's reference, 1.
 */
export function meshStencilPassState(kind: MeshStencilKind): GPUDepthStencilState {
  const face = (passOp: GPUStencilOperation) =>
    ({ compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp }) as const;
  const counted = kind === 'winding' || kind === 'joint-fill';
  return {
    format: MESH_STENCIL_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face(counted ? 'increment-wrap' : 'replace'),
    stencilBack: face(counted ? 'decrement-wrap' : 'replace'),
    stencilReadMask: 0xff,
    // E39-R6: the joint stroke writes only bit 7, the joint fill only the low 7 bits (its
    // count wraps modulo 128 there, safe by K5).
    stencilWriteMask:
      kind === 'joint-stroke'
        ? MESH_JOINT_STROKE_BIT
        : kind === 'joint-fill'
          ? MESH_JOINT_COUNT_MASK
          : 0xff,
  };
}

/**
 * E39-R8: the stencil pass's reference: 1 for a union mesh (replace), 0x80 for a joint stroke,
 * 0 for a counted mesh.
 */
export function meshStencilPassReference(kind: MeshStencilKind): number {
  return kind === 'union' ? 1 : kind === 'joint-stroke' ? MESH_JOINT_STROKE_BIT : 0;
}

/**
 * The mesh pipelines: V3's fill pipeline and ST-U7's joint fill pipeline (E17 write-once), and
 * E39's cover pipelines over the fill module's entry points with the cover stencil states.
 */
export type MeshPipelineKind =
  'fill' | 'joint' | 'cover-nonzero' | 'cover-evenodd' | `cover-${MeshJointCover}`;

/** E39-R8: the cover kinds, by rule. */
export const MESH_COVER_KINDS = Object.freeze({
  nonzero: 'cover-nonzero',
  evenodd: 'cover-evenodd',
} as const satisfies Record<MeshCoverRule, MeshPipelineKind>);

/** Every mesh pipeline kind, for cache eviction. */
export const MESH_PIPELINE_KINDS: readonly MeshPipelineKind[] = Object.freeze([
  'fill',
  'joint',
  'cover-nonzero',
  'cover-evenodd',
  ...MESH_JOINT_COVERS.map((cover) => `cover-${cover}` as const),
]);

/** E39-R6: a joint cover's pipeline kind. */
export function meshJointCoverKind(cover: MeshJointCover): `cover-${MeshJointCover}` {
  return `cover-${cover}`;
}

function meshRenderStateKey(state: string): string {
  return `premultiplied-source-over/stencil8-${state}/no-cull/triangle-list-v1`;
}

export function meshPipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  kind: MeshPipelineKind = 'fill',
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: kind === 'joint' ? MESH_JOINT_SHADER_KEY : MESH_FILL_SHADER_KEY,
    layoutKey: MESH_PACKET_LAYOUT_KEY,
    vertexLayoutKey: MESH_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey:
      kind === 'fill' || kind === 'joint' ? MESH_RENDER_STATE_KEY : meshRenderStateKey(kind),
    sampleCount,
  });
}

/** E39-R8: a stencil pass pipeline's key; its target is any color format of a mesh pass. */
export function meshStencilPipelineKey(
  targetFormat: GPUTextureFormat,
  sampleCount: 1 | 4,
  kind: MeshStencilKind,
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: MESH_FILL_SHADER_KEY,
    layoutKey: MESH_PACKET_LAYOUT_KEY,
    vertexLayoutKey: MESH_VERTEX_LAYOUT_KEY,
    targetFormat: targetFormat as PrimitiveTargetFormat,
    renderStateKey: meshRenderStateKey(`stencil-${kind}`).replace(
      'premultiplied-source-over',
      'no-color',
    ),
    sampleCount,
  });
}

/**
 * E39-R1: the stencil pass pipeline over the fill module: meshVertexMain, no color writes, the
 * stencil pass state. Only group 0 is in its layout, so it draws in the main pass, a layer tile
 * pass, a mask tile pass and the count pass alike (their other groups stay bound).
 */
export function createMeshStencilPipelineDescriptor(
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  targetFormat: GPUTextureFormat,
  sampleCount: 1 | 4,
  kind: MeshStencilKind,
): GPURenderPipelineDescriptor {
  return {
    label: `vector-studio/e39-mesh-stencil-${kind}-${targetFormat}-${sampleCount}x`,
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: 'meshVertexMain', buffers: [] },
    fragment: {
      module: shaderModule,
      entryPoint: MESH_STENCIL_FRAGMENT_ENTRY_POINT,
      targets: [{ format: targetFormat, writeMask: 0 }],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    depthStencil: meshStencilPassState(kind),
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/** E39: the stencil pass's fragment entry point in MESH_FILL_SHADER. */
export const MESH_STENCIL_FRAGMENT_ENTRY_POINT = 'meshStencilFragmentMain';

export function createMeshPipelineDescriptor(
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  kind: MeshPipelineKind = 'fill',
): GPURenderPipelineDescriptor {
  const fill = kind !== 'joint';
  // E39-R6: the joint-both cover takes the joint colour on the fill record's cover quad.
  const jointCover = kind === 'cover-joint-both-nonzero' || kind === 'cover-joint-both-evenodd';
  return {
    label: `vector-studio/p3-mesh-${kind}-${sampleCount}x`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: fill ? 'meshVertexMain' : MESH_JOINT_VERTEX_ENTRY_POINT,
      buffers: [],
    },
    fragment: {
      module: shaderModule,
      entryPoint: jointCover
        ? MESH_JOINT_COVER_FRAGMENT_ENTRY_POINT
        : fill
          ? 'meshFragmentMain'
          : MESH_JOINT_FRAGMENT_ENTRY_POINT,
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
    // E17-K2: write-once per draw; the draw's reference is set before it is encoded. E39-R2:
    // a cover pipeline tests the stencil pass's count and zeroes it.
    depthStencil:
      kind === 'cover-nonzero'
        ? meshCoverStencilState('nonzero')
        : kind === 'cover-evenodd'
          ? meshCoverStencilState('evenodd')
          : kind === 'fill' || kind === 'joint'
            ? meshWriteOnceStencilState()
            : meshJointCoverStencilState(kind.slice('cover-'.length) as MeshJointCover),
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/**
 * E39-R5: the stencil sequence of one pass's mesh draws in encoded order. A partition draw
 * takes the next E17 ordinal (meshStencilStep); a winding or union draw takes none, and is
 * preceded by a reset draw when a partition draw has written since the last reset. The main
 * pass, each layer tile pass, each mask tile pass and E10's count pass all follow it.
 */
export class MeshStencilSequence {
  #ordinal = 0;
  #written = false;

  /** A partition draw's reference and whether a reset draw precedes it. */
  public partition(): Readonly<{ reset: boolean; reference: number }> {
    const step = meshStencilStep(this.#ordinal);
    this.#ordinal += 1;
    this.#written = true;
    return step;
  }

  /** Whether a reset draw precedes this winding or union draw. */
  public winding(): boolean {
    const reset = this.#written;
    this.#written = false;
    return reset;
  }
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
