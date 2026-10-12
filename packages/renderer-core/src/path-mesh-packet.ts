import type {
  MeshReceiptResource,
  MeshResource,
  MeshResourceId,
  MeshWrite,
  PrimitiveRecordVersion,
} from './primitive-packet.js';
import { toDyadic } from './path-buckets.js';
import type { PathMeshDraw } from './path-mesh-pipeline.js';

// The packet mesh part of the P3 V3 contract, section f, unit V3b: the per-view O-PX(128) mesh
// origin, the six mesh resources with their byte layouts, first-fit range management with
// fragmentation repacking, record versions, receipts and latest-state reconstruction. V3b
// packs region-only variants: the port's triangles with role 0 and no lists or features. V3c
// adds the fringe variants (frame corners, exterior triangles, lists and features).

export const MESH_RESOURCE_ORDER = [
  'meshPositions',
  'meshTriangles',
  'meshFeatureLists',
  'meshFeatures',
  'meshInstances',
  'meshFrame',
] as const satisfies readonly MeshResourceId[];

/** Byte strides of section f's layouts (little-endian 32-bit words). */
export const MESH_STRIDES: Readonly<Record<MeshResourceId, number>> = Object.freeze({
  meshPositions: 8,
  meshTriangles: 32,
  meshFeatureLists: 4,
  meshFeatures: 64,
  meshInstances: 64,
  meshFrame: 32,
});

/** R3's selected O-PX target in physical pixels (section f, mesh origin). */
export const MESH_ORIGIN_TARGET_PX = 128;

const MIN_ELEMENTS = 16;
const GEOMETRY_REGIONS = [
  'meshPositions',
  'meshTriangles',
  'meshFeatureLists',
  'meshFeatures',
] as const;
type GeometryRegion = (typeof GEOMETRY_REGIONS)[number];

export type MeshOrigin = Readonly<{ x: number; y: number; g: number }>;

/**
 * O-PX(T) of the R3 contract with R3's inputs: g = 2^k document units, the largest with
 * g * z * q <= T for the binary32-rounded zoom z and DPR q, decided exactly; O_m = g * floor(c / g)
 * per axis, kept while each camera axis stays within 2g of it and g is unchanged. Null when the
 * rounded zoom or DPR is not a positive finite binary32 value.
 */
export function selectMeshOrigin(
  camera: Readonly<{ x: number; y: number }>,
  zoom: number,
  devicePixelRatio: number,
  previous: MeshOrigin | null,
  target = MESH_ORIGIN_TARGET_PX,
): MeshOrigin | null {
  // A product of two binary32 values is exact in binary64 (48 significant bits, exponent range
  // inside binary64's), and scaling by a power of two inside the normal range is exact too, so
  // every comparison below is exact.
  const scale = Math.fround(zoom) * Math.fround(devicePixelRatio);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  let exponent = Math.floor(Math.log2(target / scale));
  while (2 ** exponent * scale > target) exponent -= 1;
  while (2 ** (exponent + 1) * scale <= target) exponent += 1;
  const g = 2 ** exponent;
  if (
    previous !== null &&
    previous.g === g &&
    Math.abs(camera.x - previous.x) <= 2 * g &&
    Math.abs(camera.y - previous.y) <= 2 * g
  ) {
    return previous;
  }
  return Object.freeze({ x: g * Math.floor(camera.x / g), y: g * Math.floor(camera.y / g), g });
}

/** The meshFrame lanes, or null when one is not a finite binary32 value (section f). */
export function meshFrameLanes(
  origin: MeshOrigin | null,
  camera: Readonly<{ x: number; y: number }>,
  zoom: number,
  target: Readonly<{ width: number; height: number; devicePixelRatio: number }>,
): readonly number[] | null {
  if (origin === null) return null;
  const lanes = [
    origin.x - camera.x,
    origin.y - camera.y,
    zoom,
    target.devicePixelRatio,
    target.width,
    target.height,
    0,
    0,
  ];
  return lanes.every((lane) => Number.isFinite(Math.fround(lane))) ? Object.freeze(lanes) : null;
}

export type MeshFrameCorners = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;

/**
 * Section e, frame corners: per axis, the binary32 offset k farthest toward the mesh such that,
 * in exact arithmetic, m + k lies at least rho outside the mesh bounds (k <= minX - rho - m on
 * the low side, k >= maxX + rho - m on the high side). Found by rounding the Float64 difference
 * to binary32 and stepping one binary32 ulp at a time until the exact check holds and the next
 * value toward the mesh fails it. Null when a corner is not a finite binary32 value (the state
 * failure fringe-range). V3b fixes the rule; V3c's fringe variants store these corners.
 */
export function meshFrameCorners(
  bounds: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
  midpoint: Readonly<{ x: number; y: number }>,
  rho: number,
): MeshFrameCorners | null {
  const minX = lowCorner(bounds.minX, midpoint.x, rho);
  const minY = lowCorner(bounds.minY, midpoint.y, rho);
  const maxX = highCorner(bounds.maxX, midpoint.x, rho);
  const maxY = highCorner(bounds.maxY, midpoint.y, rho);
  if (minX === null || minY === null || maxX === null || maxY === null) return null;
  return Object.freeze({ minX, minY, maxX, maxY });
}

function lowCorner(low: number, m: number, rho: number): number | null {
  // Exact: m + k <= low - rho, that is m + k + rho - low <= 0.
  const holds = (k: number) => exactSumSign([m, k, rho, -low]) <= 0;
  let k = Math.fround(low - rho - m);
  if (!Number.isFinite(k)) return null;
  while (!holds(k)) {
    k = nextFloat32(k, -1);
    if (!Number.isFinite(k)) return null;
  }
  for (
    let inward = nextFloat32(k, 1);
    Number.isFinite(inward) && holds(inward);
    inward = nextFloat32(k, 1)
  ) {
    k = inward;
  }
  return k;
}

function highCorner(high: number, m: number, rho: number): number | null {
  // Exact: m + k >= high + rho, that is m + k - rho - high >= 0.
  const holds = (k: number) => exactSumSign([m, k, -rho, -high]) >= 0;
  let k = Math.fround(high + rho - m);
  if (!Number.isFinite(k)) return null;
  while (!holds(k)) {
    k = nextFloat32(k, 1);
    if (!Number.isFinite(k)) return null;
  }
  for (
    let inward = nextFloat32(k, -1);
    Number.isFinite(inward) && holds(inward);
    inward = nextFloat32(k, -1)
  ) {
    k = inward;
  }
  return k;
}

const float32Scratch = new Float32Array(1);
const uint32Scratch = new Uint32Array(float32Scratch.buffer);

/** The adjacent binary32 value in the given direction (+1 up, -1 down). */
function nextFloat32(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * 2 ** -149;
  float32Scratch[0] = value;
  const increase = value > 0 === direction > 0;
  uint32Scratch[0] = increase ? uint32Scratch[0]! + 1 : uint32Scratch[0]! - 1;
  return float32Scratch[0];
}

/** Sign of the exact sum of finite binary64 values. */
function exactSumSign(values: readonly number[]): -1 | 0 | 1 {
  const terms = values.filter((value) => value !== 0).map(toDyadic);
  if (terms.length === 0) return 0;
  const exponent = Math.min(...terms.map((term) => term.e));
  let sum = 0n;
  for (const term of terms) sum += term.n << BigInt(term.e - exponent);
  return sum === 0n ? 0 : sum > 0n ? 1 : -1;
}

/** Element ranges of one region: first fit over a free list that merges adjacent ranges. */
class RangeList {
  readonly capacity: number;
  #free: Array<{ offset: number; size: number }>;

  public constructor(capacity: number, used = 0) {
    this.capacity = capacity;
    this.#free = used < capacity ? [{ offset: used, size: capacity - used }] : [];
  }

  public allocate(size: number): number | undefined {
    if (size === 0) return 0;
    const index = this.#free.findIndex((range) => range.size >= size);
    if (index < 0) return undefined;
    const range = this.#free[index]!;
    const offset = range.offset;
    if (range.size === size) this.#free.splice(index, 1);
    else this.#free[index] = { offset: offset + size, size: range.size - size };
    return offset;
  }

  public release(offset: number, size: number): void {
    if (size === 0) return;
    const ranges = [...this.#free, { offset, size }].sort(
      (left, right) => left.offset - right.offset,
    );
    const merged: Array<{ offset: number; size: number }> = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last !== undefined && last.offset + last.size === range.offset) last.size += range.size;
      else merged.push({ ...range });
    }
    this.#free = merged;
  }

  public get freeTotal(): number {
    return this.#free.reduce((sum, range) => sum + range.size, 0);
  }

  public get freeRanges(): ReadonlyArray<Readonly<{ offset: number; size: number }>> {
    return this.#free;
  }
}

/** A served region-only variant placed in the arena (V3b). */
type ResidentVariant = {
  readonly entryId: symbol;
  readonly offsets: Float32Array;
  readonly indices: Uint32Array;
  readonly sizes: Readonly<Record<GeometryRegion, number>>;
  readonly bases: Record<GeometryRegion, number>;
};
type SlotRecord = {
  nodeId: string;
  variant: ResidentVariant | null;
  /** The 16 words of the last written meshInstances record. */
  instance: number[] | null;
};
type PendingRelease = Readonly<{ region: GeometryRegion; offset: number; size: number }>;

export type MeshPartInput = Readonly<{
  generation: number;
  draws: readonly PathMeshDraw[];
  slots: ReadonlyMap<string, number>;
  resident: ReadonlySet<symbol>;
  frameLanes: readonly number[] | null;
}>;

export type MeshPartOutput = Readonly<{
  resources: readonly MeshResource[];
  writes: readonly MeshWrite[];
  /** firstTriangle and triangleCount by node id, for the draws of this packet. */
  placements: ReadonlyMap<string, Readonly<{ firstTriangle: number; triangleCount: number }>>;
  expected: ReadonlyMap<MeshResourceId, ReadonlyMap<number, symbol>>;
}>;

export type MeshArenaStatistics = Readonly<{
  arenaReplacements: number;
  repacks: number;
  capacities: Readonly<Record<MeshResourceId, number>>;
  freeElements: Readonly<Record<GeometryRegion, number>>;
  pendingReleases: number;
}>;

/** CPU owner of the mesh part's resources, ranges and record versions. */
export class PathMeshPacker {
  #capacities: Record<MeshResourceId, number> = initialCapacities();
  #buffers: Record<MeshResourceId, Uint8Array> = createBuffers(this.#capacities);
  #incarnations: Record<MeshResourceId, symbol> = createIncarnations();
  #versions: Record<MeshResourceId, Array<symbol | undefined>> = createVersions();
  #dirty: Record<MeshResourceId, number> = createCounts();
  #ranges: Record<GeometryRegion, RangeList> = createRanges(this.#capacities);
  #pendingReleases: PendingRelease[] = [];
  #records = new Map<number, SlotRecord>();
  #frame: readonly number[] | null = null;
  #generation: number | null = null;
  #slotDemand = 0;
  #arenaReplacements = 0;
  #repacks = 0;

  public prepare(input: MeshPartInput): MeshPartOutput {
    // Ranges released by the previous packet are reusable from this one on: the GPU reads of
    // the earlier submission precede this packet's queue writes.
    for (const release of this.#pendingReleases) {
      this.#ranges[release.region].release(release.offset, release.size);
    }
    this.#pendingReleases = [];

    if (input.generation !== this.#generation) {
      // A new generation reconstructs every occupied record from the CPU state, byte for byte.
      this.#generation = input.generation;
      this.#markAllDirty();
    }

    // Removed nodes, reused slots and evicted entries release their ranges.
    for (const [slot, record] of this.#records) {
      if (input.slots.get(record.nodeId) !== slot) {
        this.#releaseVariant(record);
        this.#records.delete(slot);
        this.#setVersion('meshInstances', slot, undefined);
        continue;
      }
      if (record.variant !== null && !input.resident.has(record.variant.entryId)) {
        this.#releaseVariant(record);
      }
    }

    // meshInstances has one record per path slot and grows by power of two; any growth
    // replaces the whole arena.
    let slotDemand = 0;
    for (const slot of input.slots.values()) slotDemand = Math.max(slotDemand, slot + 1);
    this.#slotDemand = slotDemand;
    if (capacityFor(slotDemand) > this.#capacities.meshInstances / MESH_STRIDES.meshInstances) {
      this.#replaceArena(null);
    }

    for (const draw of input.draws) {
      let record = this.#records.get(draw.slot);
      if (record === undefined) {
        record = { nodeId: draw.nodeId, variant: null, instance: null };
        this.#records.set(draw.slot, record);
      }
      if (record.variant?.entryId !== draw.entryId) {
        this.#releaseVariant(record);
        record.variant = this.#placeVariant(draw);
      }
      this.#writeInstance(draw.slot, record, instanceWords(draw, record.variant));
    }
    // Read placements only after every draw is placed: a repack moves earlier variants.
    const placements = new Map<string, { firstTriangle: number; triangleCount: number }>();
    for (const draw of input.draws) {
      const variant = this.#records.get(draw.slot)!.variant!;
      placements.set(
        draw.nodeId,
        Object.freeze({
          firstTriangle: variant.bases.meshTriangles,
          triangleCount: variant.sizes.meshTriangles,
        }),
      );
    }

    if (input.frameLanes !== null && !numbersEqual(this.#frame, input.frameLanes)) {
      this.#frame = input.frameLanes;
      this.#writeFloat32('meshFrame', 0, input.frameLanes);
      this.#setVersion('meshFrame', 0, Symbol('meshFrame-0'));
    }

    const writes = this.#makeWrites();
    return Object.freeze({
      resources: Object.freeze(
        MESH_RESOURCE_ORDER.map((id) =>
          Object.freeze({
            id,
            incarnation: this.#incarnations[id],
            capacityBytes: this.#capacities[id],
          }),
        ),
      ),
      writes: Object.freeze(writes),
      placements,
      expected: expectedRecords(writes),
    });
  }

  /**
   * Validates a submitted mesh receipt part like P1's: the packet's resource count (six, or
   * none for a notices-only part) in fixed order, current incarnations, and exactly the expected
   * record versions. Returns the records to clear, or null.
   */
  public validateReceipt(
    resources: readonly MeshReceiptResource[],
    expected: ReadonlyMap<MeshResourceId, ReadonlyMap<number, symbol>>,
    resourceCount: number,
  ): readonly MeshReceiptResource[] | null {
    if (!isList(resources) || resources.length !== resourceCount) return null;
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index]!;
      const id = MESH_RESOURCE_ORDER[index]!;
      if (resource.resourceId !== id || resource.incarnation !== this.#incarnations[id]) {
        return null;
      }
      const records = expected.get(id);
      if (resource.records.length !== (records?.size ?? 0)) return null;
      const seen = new Set<number>();
      for (const record of resource.records) {
        if (seen.has(record.index) || records?.get(record.index) !== record.version) return null;
        seen.add(record.index);
      }
    }
    return resources;
  }

  public acknowledge(resources: readonly MeshReceiptResource[]): void {
    for (const resource of resources) {
      for (const record of resource.records) {
        if (this.#versions[resource.resourceId][record.index] === record.version) {
          this.#setVersion(resource.resourceId, record.index, undefined);
        }
      }
    }
  }

  public getStatistics(): MeshArenaStatistics {
    return Object.freeze({
      arenaReplacements: this.#arenaReplacements,
      repacks: this.#repacks,
      capacities: Object.freeze({ ...this.#capacities }),
      freeElements: Object.freeze({
        meshPositions: this.#ranges.meshPositions.freeTotal,
        meshTriangles: this.#ranges.meshTriangles.freeTotal,
        meshFeatureLists: this.#ranges.meshFeatureLists.freeTotal,
        meshFeatures: this.#ranges.meshFeatures.freeTotal,
      }),
      pendingReleases: this.#pendingReleases.length,
    });
  }

  /** The element ranges of a slot's served variant, for tests and diagnostics. */
  public getSlotRanges(slot: number): Readonly<Record<GeometryRegion, number>> | null {
    const variant = this.#records.get(slot)?.variant;
    return variant === undefined || variant === null ? null : Object.freeze({ ...variant.bases });
  }

  public dispose(): void {
    this.#records.clear();
    this.#pendingReleases = [];
    this.#frame = null;
    this.#versions = createVersions();
    this.#dirty = createCounts();
  }

  #placeVariant(draw: PathMeshDraw): ResidentVariant {
    const sizes = Object.freeze({
      meshPositions: draw.offsets.length / 2,
      meshTriangles: draw.mesh.indices.length / 3,
      meshFeatureLists: 0,
      meshFeatures: 0,
    });
    const variant: ResidentVariant = {
      entryId: draw.entryId,
      offsets: draw.offsets,
      indices: draw.mesh.indices,
      sizes,
      bases: { meshPositions: 0, meshTriangles: 0, meshFeatureLists: 0, meshFeatures: 0 },
    };
    if (this.#allocate(variant)) {
      this.#writeVariant(variant);
    } else {
      // No free range fits: fragmentation when the free totals would, growth otherwise. Either
      // way the arena is replaced and every resident variant is repacked contiguously.
      this.#replaceArena(variant);
    }
    return variant;
  }

  #allocate(variant: ResidentVariant): boolean {
    const bases: Partial<Record<GeometryRegion, number>> = {};
    for (const region of GEOMETRY_REGIONS) {
      const offset = this.#ranges[region].allocate(variant.sizes[region]);
      if (offset === undefined) {
        for (const placed of GEOMETRY_REGIONS) {
          const base = bases[placed];
          if (base !== undefined) this.#ranges[placed].release(base, variant.sizes[placed]);
        }
        return false;
      }
      bases[region] = offset;
    }
    Object.assign(variant.bases, bases);
    return true;
  }

  #releaseVariant(record: SlotRecord): void {
    const variant = record.variant;
    if (variant === null) return;
    record.variant = null;
    for (const region of GEOMETRY_REGIONS) {
      const size = variant.sizes[region];
      if (size === 0) continue;
      this.#pendingReleases.push(Object.freeze({ region, offset: variant.bases[region], size }));
      for (let index = 0; index < size; index += 1) {
        this.#setVersion(region, variant.bases[region] + index, undefined);
      }
    }
  }

  /** Replaces the arena: new incarnations, contiguous repacking, everything rewritten. */
  #replaceArena(extra: ResidentVariant | null): void {
    const variants = [...this.#records.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, record]) => (record.variant === null ? [] : [record.variant]));
    if (extra !== null) variants.push(extra);
    const capacities = { ...this.#capacities };
    for (const region of GEOMETRY_REGIONS) {
      const used = variants.reduce((sum, variant) => sum + variant.sizes[region], 0);
      const elements = capacities[region] / MESH_STRIDES[region];
      if (used > elements) capacities[region] = capacityFor(used) * MESH_STRIDES[region];
    }
    capacities.meshInstances = Math.max(
      capacities.meshInstances,
      capacityFor(this.#slotDemand) * MESH_STRIDES.meshInstances,
    );
    const grew = MESH_RESOURCE_ORDER.some((id) => capacities[id] !== this.#capacities[id]);
    if (!grew) this.#repacks += 1;
    this.#arenaReplacements += 1;
    this.#capacities = capacities;
    this.#buffers = createBuffers(capacities);
    this.#incarnations = createIncarnations();
    this.#versions = createVersions();
    this.#dirty = createCounts();
    this.#pendingReleases = [];
    const cursor: Record<GeometryRegion, number> = {
      meshPositions: 0,
      meshTriangles: 0,
      meshFeatureLists: 0,
      meshFeatures: 0,
    };
    for (const variant of variants) {
      for (const region of GEOMETRY_REGIONS) {
        variant.bases[region] = cursor[region];
        cursor[region] += variant.sizes[region];
      }
      this.#writeVariant(variant);
    }
    this.#ranges = {
      meshPositions: new RangeList(capacities.meshPositions / 8, cursor.meshPositions),
      meshTriangles: new RangeList(capacities.meshTriangles / 32, cursor.meshTriangles),
      meshFeatureLists: new RangeList(capacities.meshFeatureLists / 4, cursor.meshFeatureLists),
      meshFeatures: new RangeList(capacities.meshFeatures / 64, cursor.meshFeatures),
    };
    for (const [slot, record] of this.#records) {
      if (record.instance === null) continue;
      if (record.variant !== null) {
        record.instance[12] = record.variant.bases.meshPositions;
        record.instance[13] = record.variant.bases.meshFeatureLists;
        record.instance[14] = record.variant.bases.meshFeatures;
      }
      this.#writeInstance(slot, record, record.instance, true);
    }
    if (this.#frame !== null) {
      this.#writeFloat32('meshFrame', 0, this.#frame);
      this.#setVersion('meshFrame', 0, Symbol('meshFrame-0'));
    }
  }

  #writeVariant(variant: ResidentVariant): void {
    const positions = new DataView(this.#buffers.meshPositions.buffer);
    const vertexBase = variant.bases.meshPositions;
    const version = Symbol('meshPositions-range');
    for (let index = 0; index < variant.sizes.meshPositions; index += 1) {
      const byte = (vertexBase + index) * MESH_STRIDES.meshPositions;
      positions.setFloat32(byte, variant.offsets[2 * index]!, true);
      positions.setFloat32(byte + 4, variant.offsets[2 * index + 1]!, true);
      this.#setVersion('meshPositions', vertexBase + index, version);
    }
    const triangles = new DataView(this.#buffers.meshTriangles.buffer);
    const triangleBase = variant.bases.meshTriangles;
    const triangleVersion = Symbol('meshTriangles-range');
    for (let index = 0; index < variant.sizes.meshTriangles; index += 1) {
      const byte = (triangleBase + index) * MESH_STRIDES.meshTriangles;
      // u32 i0, i1, i2 (variant-relative, counter-clockwise as the port gives them); listOffset,
      // listCount, role 0 (region); two zero words. V3b variants have no lists.
      triangles.setUint32(byte, variant.indices[3 * index]!, true);
      triangles.setUint32(byte + 4, variant.indices[3 * index + 1]!, true);
      triangles.setUint32(byte + 8, variant.indices[3 * index + 2]!, true);
      for (let word = 3; word < 8; word += 1) triangles.setUint32(byte + 4 * word, 0, true);
      this.#setVersion('meshTriangles', triangleBase + index, triangleVersion);
    }
  }

  #writeInstance(slot: number, record: SlotRecord, words: number[], force = false): void {
    if (!force && numbersEqual(record.instance, words)) return;
    const view = new DataView(this.#buffers.meshInstances.buffer);
    const byte = slot * MESH_STRIDES.meshInstances;
    for (let word = 0; word < 12; word += 1) view.setFloat32(byte + 4 * word, words[word]!, true);
    for (let word = 12; word < 16; word += 1) view.setUint32(byte + 4 * word, words[word]!, true);
    record.instance = words;
    this.#setVersion('meshInstances', slot, Symbol(`meshInstances-${slot}`));
  }

  #writeFloat32(resource: MeshResourceId, byteOffset: number, lanes: readonly number[]): void {
    const view = new DataView(this.#buffers[resource].buffer);
    lanes.forEach((lane, index) => view.setFloat32(byteOffset + 4 * index, lane, true));
  }

  #setVersion(resource: MeshResourceId, index: number, version: symbol | undefined): void {
    const versions = this.#versions[resource];
    const previous = versions[index];
    if (previous === undefined && version !== undefined) this.#dirty[resource] += 1;
    if (previous !== undefined && version === undefined) this.#dirty[resource] -= 1;
    versions[index] = version;
  }

  #markAllDirty(): void {
    for (const record of this.#records.values()) {
      if (record.variant !== null) this.#writeVariant(record.variant);
    }
    for (const [slot, record] of this.#records) {
      if (record.instance !== null) {
        this.#setVersion('meshInstances', slot, Symbol(`meshInstances-${slot}`));
      }
    }
    if (this.#frame !== null) this.#setVersion('meshFrame', 0, Symbol('meshFrame-0'));
  }

  #makeWrites(): MeshWrite[] {
    const writes: MeshWrite[] = [];
    for (const resourceId of MESH_RESOURCE_ORDER) {
      if (this.#dirty[resourceId] === 0) continue;
      const versions = this.#versions[resourceId];
      const stride = MESH_STRIDES[resourceId];
      let first = -1;
      const flush = (end: number) => {
        if (first < 0) return;
        const records: PrimitiveRecordVersion[] = [];
        for (let index = first; index < end; index += 1) {
          records.push(Object.freeze({ index, version: versions[index]! }));
        }
        writes.push(
          Object.freeze({
            resourceId,
            incarnation: this.#incarnations[resourceId],
            byteOffset: first * stride,
            bytes: this.#buffers[resourceId].slice(first * stride, end * stride),
            records: Object.freeze(records),
          }),
        );
        first = -1;
      };
      for (let index = 0; index < versions.length; index += 1) {
        if (versions[index] === undefined) flush(index);
        else if (first < 0) first = index;
      }
      flush(versions.length);
    }
    return writes;
  }
}

/** The 16 words of a meshInstances record (section f). Words 12-15 are u32. */
function instanceWords(draw: PathMeshDraw, variant: ResidentVariant): number[] {
  const words = [
    draw.linear[0],
    draw.linear[1],
    draw.linear[2],
    draw.linear[3],
    draw.anchor[0],
    draw.anchor[1],
    draw.orientation,
    draw.opacity,
    draw.fill.r,
    draw.fill.g,
    draw.fill.b,
    draw.fill.a,
    variant.bases.meshPositions,
    variant.bases.meshFeatureLists,
    variant.bases.meshFeatures,
    0,
  ];
  for (let word = 0; word < 12; word += 1) words[word] = Math.fround(words[word]!);
  return words;
}

function expectedRecords(
  writes: readonly MeshWrite[],
): ReadonlyMap<MeshResourceId, ReadonlyMap<number, symbol>> {
  const expected = new Map<MeshResourceId, Map<number, symbol>>();
  for (const write of writes) {
    let records = expected.get(write.resourceId);
    if (records === undefined) {
      records = new Map();
      expected.set(write.resourceId, records);
    }
    for (const record of write.records) records.set(record.index, record.version);
  }
  return expected;
}

function capacityFor(demand: number): number {
  if (!Number.isSafeInteger(demand) || demand < 0) {
    throw new RangeError('Invalid mesh capacity demand.');
  }
  let capacity = MIN_ELEMENTS;
  while (capacity < demand) {
    capacity *= 2;
    if (!Number.isSafeInteger(capacity)) throw new RangeError('Mesh capacity overflow.');
  }
  return capacity;
}

function initialCapacities(): Record<MeshResourceId, number> {
  return {
    meshPositions: MIN_ELEMENTS * MESH_STRIDES.meshPositions,
    meshTriangles: MIN_ELEMENTS * MESH_STRIDES.meshTriangles,
    meshFeatureLists: MIN_ELEMENTS * MESH_STRIDES.meshFeatureLists,
    meshFeatures: MIN_ELEMENTS * MESH_STRIDES.meshFeatures,
    meshInstances: MIN_ELEMENTS * MESH_STRIDES.meshInstances,
    meshFrame: MESH_STRIDES.meshFrame,
  };
}

function createBuffers(
  capacities: Readonly<Record<MeshResourceId, number>>,
): Record<MeshResourceId, Uint8Array> {
  return {
    meshPositions: new Uint8Array(capacities.meshPositions),
    meshTriangles: new Uint8Array(capacities.meshTriangles),
    meshFeatureLists: new Uint8Array(capacities.meshFeatureLists),
    meshFeatures: new Uint8Array(capacities.meshFeatures),
    meshInstances: new Uint8Array(capacities.meshInstances),
    meshFrame: new Uint8Array(capacities.meshFrame),
  };
}

function createRanges(
  capacities: Readonly<Record<MeshResourceId, number>>,
): Record<GeometryRegion, RangeList> {
  return {
    meshPositions: new RangeList(capacities.meshPositions / MESH_STRIDES.meshPositions),
    meshTriangles: new RangeList(capacities.meshTriangles / MESH_STRIDES.meshTriangles),
    meshFeatureLists: new RangeList(capacities.meshFeatureLists / MESH_STRIDES.meshFeatureLists),
    meshFeatures: new RangeList(capacities.meshFeatures / MESH_STRIDES.meshFeatures),
  };
}

function createIncarnations(): Record<MeshResourceId, symbol> {
  return {
    meshPositions: Symbol('meshPositions-incarnation'),
    meshTriangles: Symbol('meshTriangles-incarnation'),
    meshFeatureLists: Symbol('meshFeatureLists-incarnation'),
    meshFeatures: Symbol('meshFeatures-incarnation'),
    meshInstances: Symbol('meshInstances-incarnation'),
    meshFrame: Symbol('meshFrame-incarnation'),
  };
}

function createVersions(): Record<MeshResourceId, Array<symbol | undefined>> {
  return {
    meshPositions: [],
    meshTriangles: [],
    meshFeatureLists: [],
    meshFeatures: [],
    meshInstances: [],
    meshFrame: [],
  };
}

function createCounts(): Record<MeshResourceId, number> {
  return {
    meshPositions: 0,
    meshTriangles: 0,
    meshFeatureLists: 0,
    meshFeatures: 0,
    meshInstances: 0,
    meshFrame: 0,
  };
}

/** An array check that does not narrow a typed value to any[]. */
function isList(value: unknown): boolean {
  return Array.isArray(value);
}

function numbersEqual(left: readonly number[] | null, right: readonly number[]): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
