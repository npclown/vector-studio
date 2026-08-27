export const RESOURCE_CATEGORIES = Object.freeze([
  'buffer',
  'texture',
  'texture-view',
  'sampler',
  'bind-group',
  'bind-group-layout',
  'pipeline-layout',
  'render-pipeline',
  'shader-module',
] as const);

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export interface BufferResourceDescriptor {
  readonly category: 'buffer';
  /** Descriptor byte size. Allocator padding outside this size is not estimated. */
  readonly size: number;
}

export interface TextureResourceDescriptor {
  readonly category: 'texture';
  readonly dimension: '2d' | '2d-array' | '3d';
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  /** Uncompressed bytes per texel. Compressed formats require a future block-aware rule. */
  readonly bytesPerTexel: number;
}

export interface CountOnlyResourceDescriptor {
  readonly category: Exclude<ResourceCategory, 'buffer' | 'texture'>;
}

export type ResourceDescriptor =
  BufferResourceDescriptor | TextureResourceDescriptor | CountOnlyResourceDescriptor;

export interface ResourceCategoryStatistics {
  readonly created: number;
  readonly live: number;
  readonly liveBytes: number;
  readonly peakLiveBytes: number;
}

export interface ResourceAccountingSnapshot {
  readonly created: number;
  readonly live: number;
  readonly liveBytes: number;
  readonly peakLiveBytes: number;
  readonly byCategory: Readonly<Record<ResourceCategory, ResourceCategoryStatistics>>;
}
