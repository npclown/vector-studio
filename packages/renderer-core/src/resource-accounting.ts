import {
  RESOURCE_CATEGORIES,
  type ResourceAccountingSnapshot,
  type ResourceCategory,
  type ResourceCategoryStatistics,
  type ResourceDescriptor,
  type TextureResourceDescriptor,
} from '@vector-studio/contracts';

interface TrackedResource {
  readonly category: ResourceCategory;
  readonly bytes: number;
}

interface MutableCategoryStatistics {
  created: number;
  live: number;
  liveBytes: number;
  peakLiveBytes: number;
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function assertSafePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}

function checkedNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds Number.MAX_SAFE_INTEGER.`);
  }

  return Number(value);
}

function checkedSum(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${field} exceeds Number.MAX_SAFE_INTEGER.`);
  }

  return result;
}

export function estimateTextureBytes(descriptor: TextureResourceDescriptor): number {
  assertSafePositiveInteger(descriptor.width, 'width');
  assertSafePositiveInteger(descriptor.height, 'height');
  assertSafePositiveInteger(descriptor.depthOrArrayLayers, 'depthOrArrayLayers');
  assertSafePositiveInteger(descriptor.mipLevelCount, 'mipLevelCount');
  assertSafePositiveInteger(descriptor.sampleCount, 'sampleCount');
  assertSafePositiveInteger(descriptor.bytesPerTexel, 'bytesPerTexel');

  let total = 0n;

  for (let level = 0; level < descriptor.mipLevelCount; level += 1) {
    const divisor = 2 ** level;
    const width = Math.max(1, Math.floor(descriptor.width / divisor));
    const height = Math.max(1, Math.floor(descriptor.height / divisor));
    const depth =
      descriptor.dimension === '3d'
        ? Math.max(1, Math.floor(descriptor.depthOrArrayLayers / divisor))
        : descriptor.depthOrArrayLayers;

    total +=
      BigInt(width) *
      BigInt(height) *
      BigInt(depth) *
      BigInt(descriptor.sampleCount) *
      BigInt(descriptor.bytesPerTexel);
  }

  return checkedNumber(total, 'texture byte estimate');
}

export function estimateResourceBytes(descriptor: ResourceDescriptor): number {
  if (descriptor.category === 'buffer') {
    assertSafeNonNegativeInteger(descriptor.size, 'size');
    return descriptor.size;
  }

  if (descriptor.category === 'texture') {
    return estimateTextureBytes(descriptor);
  }

  return 0;
}

function createEmptyCategoryStatistics(): Record<ResourceCategory, MutableCategoryStatistics> {
  return Object.fromEntries(
    RESOURCE_CATEGORIES.map((category) => [
      category,
      { created: 0, live: 0, liveBytes: 0, peakLiveBytes: 0 },
    ]),
  ) as Record<ResourceCategory, MutableCategoryStatistics>;
}

export class ResourceAccounting {
  readonly #categories = createEmptyCategoryStatistics();
  readonly #resources = new Map<string, TrackedResource>();
  #created = 0;
  #liveBytes = 0;
  #peakLiveBytes = 0;

  track(id: string, descriptor: ResourceDescriptor): number {
    if (id.length === 0) {
      throw new TypeError('Resource id must not be empty.');
    }
    if (this.#resources.has(id)) {
      throw new Error(`Resource id is already tracked: ${id}`);
    }

    const bytes = estimateResourceBytes(descriptor);
    const categoryStatistics = this.#categories[descriptor.category];
    const nextLiveBytes = checkedSum(this.#liveBytes, bytes, 'live resource bytes');
    const nextCategoryLiveBytes = checkedSum(
      categoryStatistics.liveBytes,
      bytes,
      `${descriptor.category} live resource bytes`,
    );

    this.#resources.set(id, { category: descriptor.category, bytes });
    this.#created += 1;
    this.#liveBytes = nextLiveBytes;
    this.#peakLiveBytes = Math.max(this.#peakLiveBytes, this.#liveBytes);
    categoryStatistics.created += 1;
    categoryStatistics.live += 1;
    categoryStatistics.liveBytes = nextCategoryLiveBytes;
    categoryStatistics.peakLiveBytes = Math.max(
      categoryStatistics.peakLiveBytes,
      categoryStatistics.liveBytes,
    );

    return bytes;
  }

  release(id: string): boolean {
    const resource = this.#resources.get(id);
    if (!resource) {
      return false;
    }

    const categoryStatistics = this.#categories[resource.category];
    this.#resources.delete(id);
    this.#liveBytes -= resource.bytes;
    categoryStatistics.live -= 1;
    categoryStatistics.liveBytes -= resource.bytes;
    return true;
  }

  clear(): void {
    for (const statistics of Object.values(this.#categories)) {
      statistics.live = 0;
      statistics.liveBytes = 0;
    }
    this.#resources.clear();
    this.#liveBytes = 0;
  }

  snapshot(): ResourceAccountingSnapshot {
    const byCategory = Object.fromEntries(
      RESOURCE_CATEGORIES.map((category) => {
        const statistics = this.#categories[category];
        return [category, Object.freeze({ ...statistics })];
      }),
    ) as Record<ResourceCategory, ResourceCategoryStatistics>;

    return Object.freeze({
      created: this.#created,
      live: this.#resources.size,
      liveBytes: this.#liveBytes,
      peakLiveBytes: this.#peakLiveBytes,
      byCategory: Object.freeze(byCategory),
    });
  }
}
