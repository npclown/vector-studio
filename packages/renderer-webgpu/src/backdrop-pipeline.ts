import type { DeviceRect } from '@vector-studio/renderer-core';
import type { PipelineCacheKey } from './pipeline-cache.js';
import type { PrimitiveTargetFormat } from './primitive-pipeline.js';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-K4: the backdrop snapshot,
// shared with V-36's background blur. Before a blend root's composite, the parent pass is ended
// (storing colour and stencil), a resolve pass copies the parent attachment's pixels under the
// root's output bound into a single-sample texture of the target format, reading them with
// `textureLoad` (at 4x the average of the samples, as the hardware resolve; at 1x the texel),
// and the parent pass is resumed with `loadOp: 'load'` for colour and stencil. A pixel of the
// snapshot past the attachment reads its nearest attachment pixel (clamp to edge, for a margin).

export const BACKDROP_SNAPSHOT_SHADER_KEY = 'v35-backdrop-snapshot-v0';
export const BACKDROP_SNAPSHOT_LAYOUT_KEY = 'v35-backdrop-snapshot-v0';
export const BACKDROP_SNAPSHOT_BINDINGS = Object.freeze({ parent: 0, record: 1 });
/** One record: the snapshot origin minus the pass's shift, and the attachment's last pixel. */
export const BACKDROP_SNAPSHOT_RECORD_SIZE = 16;
const BACKDROP_SNAPSHOT_RENDER_STATE_KEY = 'replace/no-depth/no-cull/triangle-list-v1';

const FRAGMENT_VISIBILITY = 0x2;
/** V35-K4: the usage an attachment needs to be read by the snapshot (TEXTURE_BINDING). */
export const BACKDROP_PARENT_USAGE = 0x04;

/** The resolve module for an attachment of `sampleCount` samples. */
export function backdropSnapshotShader(sampleCount: 1 | 4): string {
  const texture = sampleCount === 4 ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>';
  const read =
    sampleCount === 4
      ? `(textureLoad(parentTexture, texel, 0) + textureLoad(parentTexture, texel, 1) +
      textureLoad(parentTexture, texel, 2) + textureLoad(parentTexture, texel, 3)) * 0.25`
      : 'textureLoad(parentTexture, texel, 0)';
  return /* wgsl */ `
struct SnapshotRecord {
  delta: vec2f,
  last: vec2f,
};

@group(0) @binding(${BACKDROP_SNAPSHOT_BINDINGS.parent}) var parentTexture: ${texture};
@group(0) @binding(${BACKDROP_SNAPSHOT_BINDINGS.record}) var<uniform> snapshot: SnapshotRecord;

@vertex
fn snapshotVertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vertexIndex], 0.0, 1.0);
}

@fragment
fn snapshotFragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = clamp(floor(position.xy) + snapshot.delta, vec2f(0.0), snapshot.last);
  let texel = vec2i(pixel);
  return ${read};
}
`;
}

export function backdropSnapshotPipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: `${BACKDROP_SNAPSHOT_SHADER_KEY}-from-${sampleCount}x`,
    layoutKey: `${BACKDROP_SNAPSHOT_LAYOUT_KEY}-${sampleCount}x`,
    vertexLayoutKey: 'none-3-v0',
    targetFormat,
    renderStateKey: BACKDROP_SNAPSHOT_RENDER_STATE_KEY,
    // The snapshot itself is single-sample; the key names the attachment it reads.
    sampleCount: 1,
  });
}

export function createBackdropSnapshotBindGroupLayoutDescriptor(
  sampleCount: 1 | 4,
): GPUBindGroupLayoutDescriptor {
  return {
    label: `vector-studio/v35-backdrop-snapshot-${sampleCount}x-layout`,
    entries: [
      {
        binding: BACKDROP_SNAPSHOT_BINDINGS.parent,
        visibility: FRAGMENT_VISIBILITY,
        texture: {
          sampleType: sampleCount === 4 ? 'unfilterable-float' : 'float',
          viewDimension: '2d',
          multisampled: sampleCount === 4,
        },
      },
      {
        binding: BACKDROP_SNAPSHOT_BINDINGS.record,
        visibility: FRAGMENT_VISIBILITY,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: BACKDROP_SNAPSHOT_RECORD_SIZE,
        },
      },
    ],
  };
}

export function createBackdropSnapshotPipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
): GPURenderPipelineDescriptor {
  return {
    label: `vector-studio/${BACKDROP_SNAPSHOT_SHADER_KEY}-from-${sampleCount}x`,
    layout,
    vertex: { module, entryPoint: 'snapshotVertexMain', buffers: [] },
    fragment: {
      module,
      entryPoint: 'snapshotFragmentMain',
      targets: [{ format: targetFormat, writeMask: 0xf }],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    multisample: { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/** A pass's attachment as a snapshot reads it: its device rectangle and its bind group. */
export type BackdropParent = Readonly<{
  pipeline: GPURenderPipeline;
  /** The attachment and the frame's records, at group 0. */
  bindGroup: GPUBindGroup;
  /** The attachment's device rectangle: the pass's shift and the attachment's size. */
  region: DeviceRect;
}>;

/** A root's snapshot texture and its absolute device origin. */
export type BackdropSnapshot = Readonly<{
  texture: GPUTexture;
  origin: Readonly<{ x: number; y: number }>;
}>;

/** The snapshot rectangle: `rect` grown by `margin` whole pixels, inside `region`. */
export function backdropRect(
  rect: DeviceRect,
  margin: number,
  region: DeviceRect,
): DeviceRect | null {
  const x = Math.max(rect.x - margin, region.x);
  const y = Math.max(rect.y - margin, region.y);
  const right = Math.min(rect.x + rect.width + margin, region.x + region.width);
  const bottom = Math.min(rect.y + rect.height + margin, region.y + region.height);
  return x < right && y < bottom ? { x, y, width: right - x, height: bottom - y } : null;
}

/** A snapshot record's bytes for a pass of `region` and a snapshot at `origin`. */
export function packBackdropSnapshotRecord(
  origin: Readonly<{ x: number; y: number }>,
  region: DeviceRect,
): Uint8Array {
  const bytes = new Uint8Array(BACKDROP_SNAPSHOT_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, origin.x - region.x, true);
  view.setFloat32(4, origin.y - region.y, true);
  view.setFloat32(8, region.width - 1, true);
  view.setFloat32(12, region.height - 1, true);
  return bytes;
}

/**
 * V35-K4: copies the parent attachment's pixels under `rect` grown by `margin` (inside the
 * attachment) into `into`, the root's snapshot, whose device origin is `into.origin`. The caller
 * has ended the parent pass (storing colour and stencil) and resumes it after this. `record` is
 * the dynamic offset of this split's record, written with `packBackdropSnapshotRecord` for this
 * parent and snapshot. In a tiled parent the snapshot is taken per tile pass, each filling its
 * part of `into`. Returns the snapshot, or null when the rectangle is empty in this pass.
 */
export function snapshotBackdrop(
  encoder: GPUCommandEncoder,
  parent: BackdropParent,
  rect: DeviceRect,
  margin: number,
  into: BackdropSnapshot,
  record: number,
): BackdropSnapshot | null {
  const area = backdropRect(rect, margin, parent.region);
  if (area === null) return null;
  const pass = encoder.beginRenderPass({
    label: 'vector-studio/backdrop-snapshot',
    colorAttachments: [{ view: into.texture.createView(), loadOp: 'load', storeOp: 'store' }],
  });
  const x = area.x - into.origin.x;
  const y = area.y - into.origin.y;
  // The viewport bounds the full-screen triangle's fragments to the area.
  pass.setViewport(x, y, area.width, area.height, 0, 1);
  pass.setPipeline(parent.pipeline);
  pass.setBindGroup(0, parent.bindGroup, [record]);
  pass.draw(3);
  pass.end();
  return into;
}
