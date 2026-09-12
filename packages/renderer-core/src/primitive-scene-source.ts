import type { RenderNodeSnapshot, SceneAffine, SceneVersion } from '@vector-studio/contracts';
import type {
  PrimitiveFrameSource,
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveRecordVersion,
  PrimitiveResource,
  PrimitiveResourceId,
  PrimitiveTarget,
  PrimitiveWrite,
} from './primitive-packet.js';
import {
  PRIMITIVE_STRIDES,
  PrimitiveNumericPreparationError,
  assessPrimitivePacking,
  normalizeRectangleRadii,
  writePackedRecord,
} from './primitive-packing.js';
import type { RetainedSceneMirror, RetainedSceneView } from './scene-mirror.js';
import {
  composeSceneAffine,
  getPrimitiveLocalStrokeBounds,
  transformSceneBounds,
  type SceneBounds,
} from './scene-numeric.js';

type InstanceResource = 'transforms' | 'geometry' | 'styles';
type Origin = Readonly<{ x: number; y: number }>;
type DerivedPrimitive = Readonly<{
  id: string;
  slot: number;
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
  world: SceneAffine;
  localBounds: SceneBounds;
  worldBounds: SceneBounds;
  hidden: boolean;
  omitted: boolean;
}>;
type VersionedRecords = {
  transforms: Array<symbol | undefined>;
  geometry: Array<symbol | undefined>;
  styles: Array<symbol | undefined>;
  order: Array<symbol | undefined>;
  frame: Array<symbol | undefined>;
};
type PendingPacket = Readonly<{
  packet: PrimitivePacket;
  expected: ReadonlyMap<PrimitiveResourceId, ReadonlyMap<number, symbol>>;
}>;
type PackingKeys = Readonly<{
  transform: readonly number[];
  geometry: readonly number[];
  style: readonly number[];
}>;
type DerivedCacheEntry = Readonly<{
  transform: SceneAffine;
  parentWorldVersion: symbol;
  worldVersion: symbol;
  world: SceneAffine;
  hidden: boolean;
  localKey: readonly number[] | null;
  localBounds: SceneBounds | null;
  worldBounds: SceneBounds | null;
  omitted: boolean;
}>;

const RESOURCE_ORDER = ['transforms', 'geometry', 'styles', 'order', 'frame'] as const;
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

export class PrimitiveSceneSource implements PrimitiveFrameSource {
  readonly #mirror: RetainedSceneMirror;
  #sceneEpoch: symbol | null = null;
  #slots = new Map<string, number>();
  #slotIds: Array<string | undefined> = [];
  #primitiveCapacity = 16;
  #orderCapacity = 16;
  #incarnations = createIncarnations();
  #buffers = createBuffers(16, 16);
  #versions: VersionedRecords = createVersions();
  #values: Record<InstanceResource, Array<readonly number[] | undefined>> = {
    transforms: [],
    geometry: [],
    styles: [],
  };
  #orderValues: number[] = [];
  #frameValues: readonly number[] | null = null;
  #origin: Origin | null = null;
  #originRevision = Symbol('primitive-origin');
  #activeGeneration: number | null = null;
  #reconstructedGeneration: number | null = null;
  #reconstructedEpoch: symbol | null = null;
  #reconstructedIncarnation: symbol | null = null;
  #pending: PendingPacket | null = null;
  #derivedCache = new Map<string, DerivedCacheEntry>();
  #packingKeys = new Map<string, PackingKeys>();
  #disposed = false;

  public constructor(mirror: RetainedSceneMirror) {
    this.#mirror = mirror;
  }

  public prepare(target: PrimitiveTarget): PrimitivePacket | null {
    if (this.#disposed) return null;
    validateTarget(target);
    const scene = this.#mirror.readRetainedScene();
    const cameraState = this.#mirror.getCameraState();
    if (scene === null || cameraState === null) return null;

    const epochChanged = scene.sceneEpoch !== this.#sceneEpoch;
    if (epochChanged) this.#resetForSnapshot(scene);
    else this.#reconcileSlots(scene);

    const derived = derivePrimitives(scene, this.#slots, this.#derivedCache);
    const visible = cullPrimitives(
      derived.filter((entry) => !entry.hidden && !entry.omitted),
      cameraState.camera,
      target,
    );
    let origin = this.#selectOrigin(cameraState.camera, visible, target);
    let rebased =
      this.#origin === null || origin.x !== this.#origin.x || origin.y !== this.#origin.y;
    if (rebased) {
      this.#origin = origin;
      this.#originRevision = Symbol('primitive-origin');
    }

    try {
      this.#assertPackingBudget(visible, cameraState.camera, target, origin);
    } catch (error) {
      const snapped = snapOrigin(cameraState.camera.position);
      if (snapped.x === origin.x && snapped.y === origin.y) throw error;
      this.#assertPackingBudget(visible, cameraState.camera, target, snapped);
      origin = snapped;
      rebased = true;
      this.#origin = snapped;
      this.#originRevision = Symbol('primitive-origin');
    }

    const grew = this.#ensureCapacities(highWater(this.#slotIds), visible.length);
    if (grew) rebased = true;
    this.#updateInstanceRecords(derived, origin, epochChanged || grew || rebased);
    this.#updateOrder(visible.map(({ slot }) => slot));
    this.#updateFrame(cameraState.camera.position, cameraState.camera.zoom, target, origin);

    const generationChanged = target.generation !== this.#activeGeneration;
    if (generationChanged) {
      this.#activeGeneration = target.generation;
      this.#pending = null;
    }
    const reconstruct =
      generationChanged ||
      epochChanged ||
      grew ||
      this.#reconstructedGeneration !== target.generation ||
      this.#reconstructedEpoch !== scene.sceneEpoch ||
      this.#reconstructedIncarnation !== this.#incarnations.transforms;
    const writes = this.#makeWrites(reconstruct);
    const packetId = Symbol('primitive-packet');
    const packet: PrimitivePacket = Object.freeze({
      layoutVersion: 1,
      scene: copyVersion(scene.version),
      sceneEpoch: scene.sceneEpoch,
      cameraRevision: cameraState.revision,
      surfaceRevision: target.surfaceRevision,
      originRevision: this.#originRevision,
      generation: target.generation,
      packetId,
      mode: reconstruct ? 'reconstruct' : 'incremental',
      resources: Object.freeze(this.#resources()),
      writes: Object.freeze(writes),
      draws: Object.freeze(
        visible.length === 0
          ? []
          : [Object.freeze({ first: 0, count: visible.length, variant: 'analytic-v1' as const })],
      ),
      frame: Object.freeze({ ...target }),
    });
    this.#pending = Object.freeze({ packet, expected: expectedRecords(writes) });
    return packet;
  }

  public acknowledge(receipt: PrimitiveReceipt): void {
    const pending = this.#pending;
    if (pending === null || !receiptMatchesPacket(receipt, pending.packet)) return;
    const received = validateReceiptResources(receipt, pending.expected, this.#incarnations);
    if (received === null) return;
    this.#pending = null;
    for (const [resourceId, records] of received) {
      for (const record of records) {
        if (this.#versions[resourceId][record.index] === record.version) {
          this.#versions[resourceId][record.index] = undefined;
        }
      }
    }
    if (pending.packet.mode === 'reconstruct') {
      this.#reconstructedGeneration = receipt.generation;
      this.#reconstructedEpoch = receipt.sceneEpoch;
      this.#reconstructedIncarnation = this.#incarnations.transforms;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sceneEpoch = null;
    this.#slots.clear();
    this.#slotIds = [];
    this.#buffers = {
      transforms: new Uint8Array(0),
      geometry: new Uint8Array(0),
      styles: new Uint8Array(0),
      order: new Uint8Array(0),
      frame: new Uint8Array(0),
    };
    this.#versions = createVersions();
    this.#values = { transforms: [], geometry: [], styles: [] };
    this.#orderValues = [];
    this.#frameValues = null;
    this.#pending = null;
    this.#derivedCache.clear();
    this.#packingKeys.clear();
  }

  #resetForSnapshot(scene: RetainedSceneView): void {
    const slots = new Map<string, number>();
    const slotIds: Array<string | undefined> = [];
    let slot = 0;
    for (const node of authoritativeTraversal(scene)) {
      if (node.kind !== 'primitive') continue;
      slots.set(node.id, slot);
      slotIds[slot] = node.id;
      slot += 1;
    }
    const primitiveCapacity = Math.max(this.#primitiveCapacity, capacityFor(slot));
    const orderCapacity = this.#orderCapacity;
    const buffers = createBuffers(primitiveCapacity, orderCapacity);
    const incarnations = createIncarnations();
    this.#sceneEpoch = scene.sceneEpoch;
    this.#slots = slots;
    this.#slotIds = slotIds;
    this.#primitiveCapacity = primitiveCapacity;
    this.#orderCapacity = orderCapacity;
    this.#incarnations = incarnations;
    this.#buffers = buffers;
    this.#versions = createVersions();
    this.#values = { transforms: [], geometry: [], styles: [] };
    this.#orderValues = [];
    this.#frameValues = null;
    this.#origin = null;
    this.#pending = null;
    this.#derivedCache.clear();
    this.#packingKeys.clear();
    this.#reconstructedEpoch = null;
    this.#reconstructedIncarnation = null;
  }

  #reconcileSlots(scene: RetainedSceneView): void {
    const primitiveIds = new Set(
      scene.nodes.filter((node) => node.kind === 'primitive').map((node) => node.id),
    );
    for (const [id, slot] of this.#slots) {
      if (primitiveIds.has(id)) continue;
      this.#slots.delete(id);
      this.#slotIds[slot] = undefined;
      this.#values.transforms[slot] = undefined;
      this.#values.geometry[slot] = undefined;
      this.#values.styles[slot] = undefined;
      this.#versions.transforms[slot] = undefined;
      this.#versions.geometry[slot] = undefined;
      this.#versions.styles[slot] = undefined;
      this.#packingKeys.delete(id);
    }
    const inserted = [...primitiveIds].filter((id) => !this.#slots.has(id)).sort(compareOrdinal);
    for (const id of inserted) {
      let slot = this.#slotIds.findIndex((entry) => entry === undefined);
      if (slot < 0) slot = this.#slotIds.length;
      this.#slots.set(id, slot);
      this.#slotIds[slot] = id;
    }
  }

  #selectOrigin(
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    visible: readonly DerivedPrimitive[],
    target: PrimitiveTarget,
  ): Origin {
    const current = this.#origin;
    if (
      current !== null &&
      Math.abs(camera.position.x - current.x) <= 512 &&
      Math.abs(camera.position.y - current.y) <= 512
    ) {
      try {
        this.#assertPackingBudget(visible, camera, target, current);
        return current;
      } catch {
        // Retry once with the current-camera anchor below.
      }
    }
    return snapOrigin(camera.position);
  }

  #assertPackingBudget(
    primitives: readonly DerivedPrimitive[],
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
    origin: Origin,
  ): void {
    for (const primitive of primitives) {
      const assessment = assessPrimitivePacking(
        primitive.world,
        primitive.localBounds,
        origin,
        camera.position,
        camera.zoom,
        target.devicePixelRatio,
        target.width,
        target.height,
        primitive.node,
      );
      if (
        assessment.quantizationPhysicalPixels > 0.125 ||
        assessment.arithmeticPhysicalPixels > 0.125
      ) {
        throw new PrimitiveNumericPreparationError('packet v1 position precision budget exceeded');
      }
    }
  }

  #ensureCapacities(primitiveDemand: number, orderDemand: number): boolean {
    const primitiveCapacity = Math.max(this.#primitiveCapacity, capacityFor(primitiveDemand));
    const orderCapacity = Math.max(this.#orderCapacity, capacityFor(orderDemand));
    if (primitiveCapacity === this.#primitiveCapacity && orderCapacity === this.#orderCapacity)
      return false;
    const buffers = createBuffers(primitiveCapacity, orderCapacity);
    this.#primitiveCapacity = primitiveCapacity;
    this.#orderCapacity = orderCapacity;
    this.#buffers = buffers;
    this.#incarnations = createIncarnations();
    this.#versions = createVersions();
    this.#values = { transforms: [], geometry: [], styles: [] };
    this.#packingKeys.clear();
    this.#orderValues = [];
    this.#frameValues = null;
    this.#pending = null;
    this.#reconstructedIncarnation = null;
    return true;
  }

  #updateInstanceRecords(
    primitives: readonly DerivedPrimitive[],
    origin: Origin,
    forceTransforms: boolean,
  ): void {
    for (const primitive of primitives) {
      const previous = this.#packingKeys.get(primitive.id);
      const transformKey = [...primitive.world, origin.x, origin.y];
      const geometryKey = primitiveGeometryKey(primitive.node);
      const styleKey = primitiveStyleKey(primitive.node);
      if (forceTransforms || !numericArraysEqual(previous?.transform, transformKey)) {
        assertPackedTransform(primitive.world, origin);
        this.#setInstanceRecord(
          'transforms',
          primitive.slot,
          [
            primitive.world[0],
            primitive.world[1],
            primitive.world[2],
            primitive.world[3],
            primitive.world[4] - origin.x,
            primitive.world[5] - origin.y,
            0,
            0,
          ],
          forceTransforms,
        );
      }
      if (!numericArraysEqual(previous?.geometry, geometryKey)) {
        this.#setInstanceRecord('geometry', primitive.slot, packGeometry(primitive.node), false);
      }
      if (!numericArraysEqual(previous?.style, styleKey)) {
        this.#setInstanceRecord('styles', primitive.slot, packStyle(primitive.node), false);
      }
      this.#packingKeys.set(
        primitive.id,
        Object.freeze({
          transform: Object.freeze(transformKey),
          geometry: Object.freeze(geometryKey),
          style: Object.freeze(styleKey),
        }),
      );
    }
  }

  #setInstanceRecord(
    resource: InstanceResource,
    slot: number,
    lanes: readonly number[],
    force: boolean,
  ): void {
    if (!force && numericArraysEqual(this.#values[resource][slot], lanes)) return;
    if (lanes.some((value) => !Number.isFinite(Math.fround(value)))) {
      throw new PrimitiveNumericPreparationError(`${resource} cannot be represented in packet v1`);
    }
    writePackedRecord(this.#buffers[resource], slot * PRIMITIVE_STRIDES[resource], resource, lanes);
    this.#values[resource][slot] = lanes;
    this.#versions[resource][slot] = Symbol(`${resource}-${slot}`);
  }

  #updateOrder(order: readonly number[]): void {
    const buffer = this.#buffers.order;
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    for (let index = 0; index < order.length; index += 1) {
      if (this.#orderValues[index] === order[index]) continue;
      view.setUint32(index * 4, order[index]!, true);
      this.#versions.order[index] = Symbol(`order-${index}`);
    }
    this.#orderValues = [...order];
    this.#versions.order.length = order.length;
  }

  #updateFrame(
    camera: Readonly<{ x: number; y: number }>,
    zoom: number,
    target: PrimitiveTarget,
    origin: Origin,
  ): void {
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
    if (
      lanes.some((value) => !Number.isFinite(Math.fround(value))) ||
      Math.fround(zoom) <= 0 ||
      Math.fround(target.devicePixelRatio) <= 0
    ) {
      throw new PrimitiveNumericPreparationError('frame cannot be represented in packet v1');
    }
    if (numericArraysEqual(this.#frameValues, lanes)) return;
    const view = new DataView(this.#buffers.frame.buffer, this.#buffers.frame.byteOffset);
    lanes.forEach((value, index) => view.setFloat32(index * 4, value, true));
    this.#frameValues = Object.freeze(lanes);
    this.#versions.frame[0] = Symbol('frame-0');
  }

  #makeWrites(reconstruct: boolean): PrimitiveWrite[] {
    const writes: PrimitiveWrite[] = [];
    for (const resourceId of RESOURCE_ORDER) {
      const indices = reconstruct
        ? this.#reconstructionIndices(resourceId)
        : dirtyIndices(this.#versions[resourceId]);
      for (const range of contiguousRanges(indices)) {
        const stride = PRIMITIVE_STRIDES[resourceId];
        const records: PrimitiveRecordVersion[] = [];
        for (let index = range.first; index <= range.last; index += 1) {
          let version = this.#versions[resourceId][index];
          if (version === undefined) {
            version = Symbol(`${resourceId}-${index}`);
            this.#versions[resourceId][index] = version;
          }
          records.push(Object.freeze({ index, version }));
        }
        writes.push(
          Object.freeze({
            resourceId,
            incarnation: this.#incarnations[resourceId],
            byteOffset: range.first * stride,
            bytes: this.#buffers[resourceId].slice(range.first * stride, (range.last + 1) * stride),
            records: Object.freeze(records),
          }),
        );
      }
    }
    return writes;
  }

  #reconstructionIndices(resourceId: PrimitiveResourceId): number[] {
    if (resourceId === 'frame') return [0];
    if (resourceId === 'order') return this.#orderValues.map((_, index) => index);
    return this.#slotIds.flatMap((id, index) => (id === undefined ? [] : [index]));
  }

  #resources(): PrimitiveResource[] {
    return RESOURCE_ORDER.map((id) =>
      Object.freeze({
        id,
        incarnation: this.#incarnations[id],
        capacityBytes: this.#buffers[id].byteLength,
      }),
    );
  }
}

function derivePrimitives(
  scene: RetainedSceneView,
  slots: ReadonlyMap<string, number>,
  cache: Map<string, DerivedCacheEntry>,
): DerivedPrimitive[] {
  const result: DerivedPrimitive[] = [];
  const present = new Set<string>();
  const rootWorldVersion = Symbol.for('vector-studio.primitive-root-world');
  const stack = [...scene.rootOrder].reverse().map((id) => ({
    id,
    parentWorld: IDENTITY,
    parentWorldVersion: rootWorldVersion,
    parentHidden: false,
  }));
  while (stack.length > 0) {
    const item = stack.pop()!;
    const node = scene.getNode(item.id)!;
    present.add(node.id);
    const previous = cache.get(node.id);
    const worldChanged =
      previous === undefined ||
      previous.parentWorldVersion !== item.parentWorldVersion ||
      !numericArraysEqual(previous.transform, node.transform);
    const world = worldChanged
      ? composeSceneAffine(item.parentWorld, node.transform)!
      : previous.world;
    const worldVersion = worldChanged ? Symbol(`world-${node.id}`) : previous.worldVersion;
    const hidden = item.parentHidden || !node.visible;
    if (node.kind === 'container') {
      cache.set(
        node.id,
        Object.freeze({
          transform: node.transform,
          parentWorldVersion: item.parentWorldVersion,
          worldVersion,
          world,
          hidden,
          localKey: null,
          localBounds: null,
          worldBounds: null,
          omitted: false,
        }),
      );
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push({
          id: node.children[index]!,
          parentWorld: world,
          parentWorldVersion: worldVersion,
          parentHidden: hidden,
        });
      }
      continue;
    }
    const localKey = primitiveBoundsKey(node);
    const boundsChanged =
      worldChanged || previous === undefined || !numericArraysEqual(previous.localKey, localKey);
    const localBounds = boundsChanged
      ? getPrimitiveLocalStrokeBounds(node)!
      : previous.localBounds!;
    const worldBounds = boundsChanged
      ? transformSceneBounds(localBounds, world)!
      : previous.worldBounds!;
    const omitted = boundsChanged ? isDegenerate(node, world) : previous.omitted;
    cache.set(
      node.id,
      Object.freeze({
        transform: node.transform,
        parentWorldVersion: item.parentWorldVersion,
        worldVersion,
        world,
        hidden,
        localKey,
        localBounds,
        worldBounds,
        omitted,
      }),
    );
    result.push(
      Object.freeze({
        id: node.id,
        slot: slots.get(node.id)!,
        node,
        world,
        localBounds,
        worldBounds,
        hidden,
        omitted,
      }),
    );
  }
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  return result;
}

function primitiveBoundsKey(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
): readonly number[] {
  const strokeWidth = node.style.stroke?.width ?? 0;
  if (node.geometry.kind === 'line') {
    return [
      2,
      node.geometry.start.x,
      node.geometry.start.y,
      node.geometry.end.x,
      node.geometry.end.y,
      strokeWidth,
    ];
  }
  return [
    node.geometry.kind === 'rectangle' ? 0 : 1,
    node.geometry.width,
    node.geometry.height,
    strokeWidth,
  ];
}

function primitiveGeometryKey(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
): readonly number[] {
  if (node.geometry.kind === 'rectangle') {
    return [0, node.geometry.width, node.geometry.height, ...node.geometry.cornerRadii];
  }
  if (node.geometry.kind === 'ellipse') return [1, node.geometry.width, node.geometry.height];
  return [
    2,
    node.geometry.start.x,
    node.geometry.start.y,
    node.geometry.end.x,
    node.geometry.end.y,
  ];
}

function primitiveStyleKey(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
): readonly number[] {
  const fill = node.style.fill;
  const stroke = node.style.stroke;
  return [
    fill === null ? 0 : 1,
    fill?.r ?? 0,
    fill?.g ?? 0,
    fill?.b ?? 0,
    fill?.a ?? 0,
    stroke === null ? 0 : 1,
    stroke?.color.r ?? 0,
    stroke?.color.g ?? 0,
    stroke?.color.b ?? 0,
    stroke?.color.a ?? 0,
    stroke?.width ?? 0,
    node.opacity,
  ];
}

function packGeometry(node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>): readonly number[] {
  const lanes = Array<number>(12).fill(0);
  if (node.geometry.kind === 'rectangle') {
    lanes[0] = 0;
    lanes[2] = node.geometry.width;
    lanes[3] = node.geometry.height;
    lanes.splice(
      4,
      4,
      ...normalizeRectangleRadii(
        node.geometry.width,
        node.geometry.height,
        node.geometry.cornerRadii,
      ),
    );
  } else if (node.geometry.kind === 'ellipse') {
    lanes[0] = 1;
    lanes[2] = node.geometry.width;
    lanes[3] = node.geometry.height;
  } else {
    lanes[0] = 2;
    lanes.splice(
      8,
      4,
      node.geometry.start.x,
      node.geometry.start.y,
      node.geometry.end.x,
      node.geometry.end.y,
    );
  }
  return lanes;
}

function packStyle(node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>): readonly number[] {
  const lanes = Array<number>(12).fill(0);
  if (node.style.fill !== null) {
    lanes.splice(0, 4, node.style.fill.r, node.style.fill.g, node.style.fill.b, node.style.fill.a);
  }
  if (node.style.stroke !== null) {
    const { color, width } = node.style.stroke;
    lanes.splice(4, 4, color.r, color.g, color.b, color.a);
    lanes[8] = width;
  }
  lanes[9] = node.opacity;
  lanes[10] = (node.style.fill === null ? 0 : 1) | (node.style.stroke === null ? 0 : 2);
  return lanes;
}

function assertPackedTransform(world: SceneAffine, origin: Origin): void {
  const lanes = [
    Math.fround(world[0]),
    Math.fround(world[1]),
    Math.fround(world[2]),
    Math.fround(world[3]),
    Math.fround(world[4] - origin.x),
    Math.fround(world[5] - origin.y),
  ];
  if (lanes.some((value) => !Number.isFinite(value))) {
    throw new PrimitiveNumericPreparationError('transform cannot be represented in packet v1');
  }
  const determinant = Math.fround(
    Math.fround(lanes[0]! * lanes[3]!) - Math.fround(lanes[1]! * lanes[2]!),
  );
  const cpuDeterminant = world[0] * world[3] - world[1] * world[2];
  if (!Number.isFinite(determinant) || (cpuDeterminant !== 0 && determinant === 0)) {
    throw new PrimitiveNumericPreparationError('transform is singular in packet v1');
  }
}

function cullPrimitives(
  primitives: readonly DerivedPrimitive[],
  camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
  target: PrimitiveTarget,
): DerivedPrimitive[] {
  const guard = 2 / (camera.zoom * target.devicePixelRatio);
  const viewport = {
    minX: camera.position.x - guard,
    minY: camera.position.y - guard,
    maxX: camera.position.x + target.width / target.devicePixelRatio / camera.zoom + guard,
    maxY: camera.position.y + target.height / target.devicePixelRatio / camera.zoom + guard,
  };
  return primitives.filter(
    ({ worldBounds }) =>
      worldBounds.maxX >= viewport.minX &&
      worldBounds.minX <= viewport.maxX &&
      worldBounds.maxY >= viewport.minY &&
      worldBounds.minY <= viewport.maxY,
  );
}

function authoritativeTraversal(scene: RetainedSceneView): RenderNodeSnapshot[] {
  const result: RenderNodeSnapshot[] = [];
  const stack = [...scene.rootOrder].reverse();
  while (stack.length > 0) {
    const node = scene.getNode(stack.pop()!)!;
    result.push(node);
    if (node.kind === 'container') {
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        stack.push(node.children[index]!);
    }
  }
  return result;
}

function isDegenerate(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
  world: SceneAffine,
): boolean {
  if (world[0] * world[3] - world[1] * world[2] === 0) return true;
  if (node.geometry.kind === 'line') {
    return (
      node.geometry.start.x === node.geometry.end.x && node.geometry.start.y === node.geometry.end.y
    );
  }
  return node.geometry.width === 0 || node.geometry.height === 0;
}

function snapOrigin(camera: Readonly<{ x: number; y: number }>): Origin {
  return Object.freeze({
    x: 256 * Math.floor(camera.x / 256),
    y: 256 * Math.floor(camera.y / 256),
  });
}

function capacityFor(demand: number): number {
  if (!Number.isSafeInteger(demand) || demand < 0)
    throw new RangeError('Invalid packet capacity demand.');
  let capacity = 16;
  while (capacity < demand) {
    capacity *= 2;
    if (!Number.isSafeInteger(capacity)) throw new RangeError('Packet capacity overflow.');
  }
  return capacity;
}

function createBuffers(primitiveCapacity: number, orderCapacity: number) {
  return {
    transforms: new Uint8Array(primitiveCapacity * PRIMITIVE_STRIDES.transforms),
    geometry: new Uint8Array(primitiveCapacity * PRIMITIVE_STRIDES.geometry),
    styles: new Uint8Array(primitiveCapacity * PRIMITIVE_STRIDES.styles),
    order: new Uint8Array(orderCapacity * PRIMITIVE_STRIDES.order),
    frame: new Uint8Array(PRIMITIVE_STRIDES.frame),
  };
}

function createIncarnations(): Record<PrimitiveResourceId, symbol> {
  return {
    transforms: Symbol('transforms-incarnation'),
    geometry: Symbol('geometry-incarnation'),
    styles: Symbol('styles-incarnation'),
    order: Symbol('order-incarnation'),
    frame: Symbol('frame-incarnation'),
  };
}

function createVersions(): VersionedRecords {
  return { transforms: [], geometry: [], styles: [], order: [], frame: [] };
}

function dirtyIndices(versions: readonly (symbol | undefined)[]): number[] {
  return versions.flatMap((version, index) => (version === undefined ? [] : [index]));
}

function contiguousRanges(indices: readonly number[]) {
  const ranges: Array<{ first: number; last: number }> = [];
  for (const index of indices) {
    const last = ranges.at(-1);
    if (last !== undefined && last.last + 1 === index) last.last = index;
    else ranges.push({ first: index, last: index });
  }
  return ranges;
}

function expectedRecords(writes: readonly PrimitiveWrite[]) {
  const expected = new Map<PrimitiveResourceId, Map<number, symbol>>();
  for (const write of writes) {
    let records = expected.get(write.resourceId);
    if (records === undefined) {
      records = new Map<number, symbol>();
      expected.set(write.resourceId, records);
    }
    for (const record of write.records) records.set(record.index, record.version);
  }
  return expected;
}

function validateReceiptResources(
  receipt: PrimitiveReceipt,
  expected: ReadonlyMap<PrimitiveResourceId, ReadonlyMap<number, symbol>>,
  incarnations: Readonly<Record<PrimitiveResourceId, symbol>>,
): ReadonlyMap<PrimitiveResourceId, readonly PrimitiveRecordVersion[]> | null {
  if (receipt.resources.length !== RESOURCE_ORDER.length) return null;
  const result = new Map<PrimitiveResourceId, readonly PrimitiveRecordVersion[]>();
  for (let resourceIndex = 0; resourceIndex < receipt.resources.length; resourceIndex += 1) {
    const resource = receipt.resources[resourceIndex]!;
    if (
      resource.resourceId !== RESOURCE_ORDER[resourceIndex] ||
      result.has(resource.resourceId) ||
      resource.incarnation !== incarnations[resource.resourceId]
    ) {
      return null;
    }
    const expectedRecordsForResource = expected.get(resource.resourceId);
    if (resource.records.length !== (expectedRecordsForResource?.size ?? 0)) {
      return null;
    }
    const indices = new Set<number>();
    for (const record of resource.records) {
      if (
        indices.has(record.index) ||
        !expectedRecordsForResource?.has(record.index) ||
        expectedRecordsForResource?.get(record.index) !== record.version
      )
        return null;
      indices.add(record.index);
    }
    result.set(resource.resourceId, resource.records);
  }
  return result;
}

function receiptMatchesPacket(receipt: PrimitiveReceipt, packet: PrimitivePacket): boolean {
  return (
    receipt.packetId === packet.packetId &&
    receipt.sceneEpoch === packet.sceneEpoch &&
    receipt.scene.identity.documentId === packet.scene.identity.documentId &&
    receipt.scene.identity.pageId === packet.scene.identity.pageId &&
    receipt.scene.revision === packet.scene.revision &&
    receipt.cameraRevision === packet.cameraRevision &&
    receipt.surfaceRevision === packet.surfaceRevision &&
    receipt.originRevision === packet.originRevision &&
    receipt.generation === packet.generation &&
    Number.isSafeInteger(receipt.submissionSerial) &&
    receipt.submissionSerial >= 0
  );
}

function numericArraysEqual(
  left: readonly number[] | null | undefined,
  right: readonly number[],
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function highWater(values: readonly (string | undefined)[]): number {
  for (let index = values.length - 1; index >= 0; index -= 1)
    if (values[index] !== undefined) return index + 1;
  return 0;
}

function copyVersion(version: SceneVersion): SceneVersion {
  return Object.freeze({
    identity: Object.freeze({
      documentId: version.identity.documentId,
      pageId: version.identity.pageId,
    }),
    revision: version.revision,
  });
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateTarget(target: PrimitiveTarget): void {
  if (
    !Number.isSafeInteger(target.generation) ||
    target.generation < 0 ||
    !Number.isSafeInteger(target.surfaceRevision) ||
    target.surfaceRevision < 0 ||
    !Number.isSafeInteger(target.width) ||
    target.width <= 0 ||
    !Number.isSafeInteger(target.height) ||
    target.height <= 0 ||
    !Number.isFinite(target.devicePixelRatio) ||
    target.devicePixelRatio <= 0 ||
    (target.sampleCount !== 1 && target.sampleCount !== 4) ||
    (target.targetFormat !== 'bgra8unorm' && target.targetFormat !== 'rgba8unorm')
  )
    throw new RangeError('Invalid primitive target.');
}
