import { createCameraTransform, transformPoint, type Point } from '@vector-studio/renderer-core';

import { PipelineCache, type PipelineCacheKey, type PipelineFactory } from './pipeline-cache.js';
import {
  SharedBufferAllocator,
  type SharedBufferAllocation,
  type SharedBufferAllocatorSnapshot,
} from './shared-buffer-allocator.js';

export const FOUNDATION_BUFFER_SIZE = 256;
export const FOUNDATION_BUFFER_ALIGNMENT = 4;

const CAMERA_POSITION = Object.freeze({ x: -20, y: -10 });
const CAMERA_ZOOM = 1.5;
const REFERENCE_NDC = Object.freeze([0, 0.65, -0.6, -0.55, 0.6, -0.55]);
const CAMERA_TRIANGLE_DOCUMENT_VERTICES = Object.freeze([0, 0, 100, 0, 0, 60]);
const COLORS = Object.freeze([0.35, 0.75, 1, 0.68, 0.35, 1, 1, 0.42, 0.55]);

export type FoundationFixture = 'camera-triangle-v1';

export interface FoundationBufferPayload {
  readonly bufferSize: number;
  readonly positions: SharedBufferAllocation;
  readonly colors: SharedBufferAllocation;
  readonly positionData: Float32Array;
  readonly colorData: Float32Array;
}

export interface FoundationExperimentSnapshot {
  readonly disposed: boolean;
  readonly allocator: SharedBufferAllocatorSnapshot;
  readonly allocations: Readonly<{
    positions: SharedBufferAllocation;
    colors: SharedBufferAllocation;
  }>;
  readonly camera: Readonly<{
    position: Point;
    zoom: number;
    devicePixelRatio: number;
  }>;
  readonly physicalSize: Readonly<{ width: number; height: number }>;
  readonly documentVertices: readonly number[];
  readonly physicalVertices: readonly number[];
  readonly ndcVertices: readonly number[];
  readonly bindingGeneration?: number;
  readonly pendingNativeCreations: number;
  readonly backingBufferCreations: number;
  readonly liveBackingBuffers: number;
  readonly pipelineCreations: number;
  readonly pipelineRequests: number;
  readonly livePipelines: number;
  readonly submittedSerial: number;
  readonly completedSerial: number;
  readonly cache: ReturnType<PipelineCache<unknown>['snapshot']>;
}

export interface FoundationBindingSource {
  readonly generation: number;
  payload(): FoundationBufferPayload;
  updateSurface(
    size: Readonly<{ width: number; height: number }>,
    devicePixelRatio: number,
  ): Float32Array;
  getOrCreatePipeline<T>(key: PipelineCacheKey, factory: PipelineFactory<T>): Promise<T>;
  prepareSubmission(): number;
  markSubmitted(serial: number): void;
  completeThrough(serial: number): void;
  recordBackingBufferCreated(): void;
  recordBackingBufferReleased(): void;
  creationSettled(): void;
  detach(): void;
}

interface BindingRecord {
  readonly generation: number;
  active: boolean;
  creationPending: boolean;
  backingBufferLive: boolean;
}

function frozenNumbers(values: readonly number[]): readonly number[] {
  return Object.freeze([...values]);
}

function requireSurface(size: Readonly<{ width: number; height: number }>, dpr: number): void {
  if (
    !Number.isSafeInteger(size.width) ||
    size.width < 0 ||
    !Number.isSafeInteger(size.height) ||
    size.height < 0
  ) {
    throw new RangeError('Physical surface dimensions must be non-negative safe integers.');
  }
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new RangeError('devicePixelRatio must be finite and strictly positive.');
  }
}

/** CPU-owned state for the internal P0 foundation experiment. */
export class FoundationExperiment {
  readonly #allocator: SharedBufferAllocator;
  readonly #positions: SharedBufferAllocation;
  readonly #colors: SharedBufferAllocation;
  #cache: PipelineCache<unknown>;
  #disposed = false;
  #binding: BindingRecord | undefined;
  #devicePixelRatio = 1;
  #physicalSize: Readonly<{ width: number; height: number }> = Object.freeze({
    width: 0,
    height: 0,
  });
  #documentVertices: readonly number[] = Object.freeze([]);
  #physicalVertices: readonly number[] = Object.freeze([]);
  #ndcVertices: readonly number[] = REFERENCE_NDC;
  #positionData = new Float32Array(REFERENCE_NDC);
  readonly #colorData = new Float32Array(COLORS);
  #pendingNativeCreations = 0;
  #backingBufferCreations = 0;
  #liveBackingBuffers = 0;
  #pipelineCreations = 0;
  #pipelineRequests = 0;
  #livePipelines = 0;
  #submittedSerial = 0;
  #completedSerial = 0;

  readonly #fixture: FoundationFixture | undefined;

  constructor(generation: number, fixture?: FoundationFixture) {
    if (fixture !== undefined && fixture !== 'camera-triangle-v1') {
      throw new RangeError(`Unsupported foundation fixture: ${String(fixture)}.`);
    }
    this.#fixture = fixture;
    this.#allocator = new SharedBufferAllocator({
      capacityBytes: FOUNDATION_BUFFER_SIZE,
      alignment: FOUNDATION_BUFFER_ALIGNMENT,
      generation,
    });
    const positions = this.#allocator.allocate(24);
    const colors = this.#allocator.allocate(36);
    if (positions === undefined || colors === undefined) {
      throw new Error('Foundation allocations do not fit their fixed backing buffer.');
    }
    this.#positions = positions;
    this.#colors = colors;
    this.#cache = this.#createCache(generation);
  }

  createBinding(
    generation: number,
    size: Readonly<{ width: number; height: number }>,
    devicePixelRatio: number,
  ): FoundationBindingSource {
    this.#requireActive();
    if (this.#binding?.active === true) {
      throw new Error('A foundation native binding is already active.');
    }
    if (generation !== this.#allocator.snapshot().generation) {
      throw new RangeError('Binding generation must equal the allocator generation.');
    }

    this.#updateSurface(size, devicePixelRatio);
    const record: BindingRecord = {
      generation,
      active: true,
      creationPending: true,
      backingBufferLive: false,
    };
    this.#binding = record;
    this.#pendingNativeCreations += 1;

    const requireBinding = () => {
      this.#requireActive();
      if (!record.active || this.#binding !== record) {
        throw new Error('Foundation binding is detached.');
      }
    };

    return Object.freeze({
      generation,
      payload: () => {
        requireBinding();
        return this.#payload();
      },
      updateSurface: (nextSize, nextDpr) => {
        requireBinding();
        this.#updateSurface(nextSize, nextDpr);
        return new Float32Array(this.#positionData);
      },
      getOrCreatePipeline: <T>(key: PipelineCacheKey, factory: PipelineFactory<T>) => {
        requireBinding();
        this.#pipelineRequests += 1;
        return this.#cache.getOrCreate(key, async (snapshot, cacheGeneration) => {
          const value = await factory(snapshot, cacheGeneration);
          this.#pipelineCreations += 1;
          this.#livePipelines += 1;
          return value;
        }) as Promise<T>;
      },
      prepareSubmission: () => {
        requireBinding();
        const serial = this.#submittedSerial + 1;
        if (!Number.isSafeInteger(serial)) {
          throw new RangeError('Foundation submission serial exceeds the safe integer range.');
        }
        return serial;
      },
      markSubmitted: (serial) => {
        requireBinding();
        if (serial !== this.#submittedSerial + 1) {
          throw new RangeError('Foundation submission serial is not the prepared next serial.');
        }
        this.#allocator.markSubmitted(record.generation, serial, [this.#positions, this.#colors]);
        this.#submittedSerial = serial;
      },
      completeThrough: (serial) => {
        if (
          this.#disposed ||
          !record.active ||
          this.#binding !== record ||
          record.generation !== this.#allocator.snapshot().generation
        ) {
          return;
        }
        this.#allocator.completeThrough(record.generation, serial);
        this.#completedSerial = Math.max(this.#completedSerial, serial);
      },
      recordBackingBufferCreated: () => {
        requireBinding();
        if (record.backingBufferLive) {
          throw new Error('Foundation backing buffer was already recorded.');
        }
        record.backingBufferLive = true;
        this.#backingBufferCreations += 1;
        this.#liveBackingBuffers += 1;
      },
      recordBackingBufferReleased: () => {
        if (!record.backingBufferLive) return;
        record.backingBufferLive = false;
        this.#liveBackingBuffers -= 1;
      },
      creationSettled: () => {
        if (!record.creationPending) return;
        record.creationPending = false;
        this.#pendingNativeCreations -= 1;
      },
      detach: () => {
        if (!record.active) return;
        record.active = false;
        if (this.#binding === record) {
          this.#binding = undefined;
        }
      },
    } satisfies FoundationBindingSource);
  }

  /** Replaces an aborted attempt's device-local cache without changing logical generation. */
  abortAttempt(generation: number): void {
    this.#requireActive();
    if (this.#binding !== undefined) {
      throw new Error('Detach the aborted native binding before replacing its cache.');
    }
    if (generation !== this.#allocator.snapshot().generation) {
      throw new RangeError('Aborted attempt generation must equal the allocator generation.');
    }
    this.#cache.dispose();
    this.#cache = this.#createCache(generation);
  }

  advanceGeneration(nextGeneration: number): void {
    this.#requireActive();
    if (this.#binding !== undefined) {
      throw new Error('Release the native binding before advancing generation.');
    }
    this.#allocator.advanceGeneration(nextGeneration);
    this.#cache.advanceGeneration(nextGeneration);
    this.#submittedSerial = 0;
    this.#completedSerial = 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#binding = undefined;
    this.#cache.dispose();
    this.#allocator.dispose();
    this.#disposed = true;
  }

  snapshot(): FoundationExperimentSnapshot {
    return Object.freeze({
      disposed: this.#disposed,
      allocator: this.#allocator.snapshot(),
      allocations: Object.freeze({ positions: this.#positions, colors: this.#colors }),
      camera: Object.freeze({
        position: CAMERA_POSITION,
        zoom: CAMERA_ZOOM,
        devicePixelRatio: this.#devicePixelRatio,
      }),
      physicalSize: this.#physicalSize,
      documentVertices: this.#documentVertices,
      physicalVertices: this.#physicalVertices,
      ndcVertices: this.#ndcVertices,
      ...(this.#binding === undefined ? {} : { bindingGeneration: this.#binding.generation }),
      pendingNativeCreations: this.#pendingNativeCreations,
      backingBufferCreations: this.#backingBufferCreations,
      liveBackingBuffers: this.#liveBackingBuffers,
      pipelineCreations: this.#pipelineCreations,
      pipelineRequests: this.#pipelineRequests,
      livePipelines: this.#livePipelines,
      submittedSerial: this.#submittedSerial,
      completedSerial: this.#completedSerial,
      cache: this.#cache.snapshot(),
    });
  }

  #payload(): FoundationBufferPayload {
    return Object.freeze({
      bufferSize: FOUNDATION_BUFFER_SIZE,
      positions: this.#positions,
      colors: this.#colors,
      positionData: new Float32Array(this.#positionData),
      colorData: new Float32Array(this.#colorData),
    });
  }

  #updateSurface(
    size: Readonly<{ width: number; height: number }>,
    devicePixelRatio: number,
  ): void {
    requireSurface(size, devicePixelRatio);
    this.#physicalSize = Object.freeze({ width: size.width, height: size.height });
    this.#devicePixelRatio = devicePixelRatio;
    if (this.#fixture === 'camera-triangle-v1') {
      this.#updateFixtureSurface(size, devicePixelRatio);
      return;
    }
    if (size.width === 0 || size.height === 0) {
      this.#documentVertices = Object.freeze([]);
      this.#physicalVertices = Object.freeze([]);
      this.#ndcVertices = REFERENCE_NDC;
      this.#positionData = new Float32Array(REFERENCE_NDC);
      return;
    }

    const camera = createCameraTransform({
      position: CAMERA_POSITION,
      zoom: CAMERA_ZOOM,
      devicePixelRatio,
    });
    const document: number[] = [];
    const physical: number[] = [];
    const ndc: number[] = [];
    for (let index = 0; index < REFERENCE_NDC.length; index += 2) {
      const ndcX = REFERENCE_NDC[index];
      const ndcY = REFERENCE_NDC[index + 1];
      if (ndcX === undefined || ndcY === undefined) {
        throw new Error('Foundation reference vertices are malformed.');
      }
      const targetPhysical = {
        x: ((ndcX + 1) * size.width) / 2,
        y: ((1 - ndcY) * size.height) / 2,
      };
      const documentPoint = transformPoint(camera.physicalToDocument, targetPhysical);
      const physicalPoint = transformPoint(camera.documentToPhysical, documentPoint);
      document.push(documentPoint.x, documentPoint.y);
      physical.push(physicalPoint.x, physicalPoint.y);
      ndc.push((physicalPoint.x / size.width) * 2 - 1, 1 - (physicalPoint.y / size.height) * 2);
    }
    this.#documentVertices = frozenNumbers(document);
    this.#physicalVertices = frozenNumbers(physical);
    this.#ndcVertices = frozenNumbers(ndc);
    this.#positionData = new Float32Array(ndc);
  }

  #updateFixtureSurface(
    size: Readonly<{ width: number; height: number }>,
    devicePixelRatio: number,
  ): void {
    const camera = createCameraTransform({
      position: CAMERA_POSITION,
      zoom: CAMERA_ZOOM,
      devicePixelRatio,
    });
    const physical: number[] = [];
    for (let index = 0; index < CAMERA_TRIANGLE_DOCUMENT_VERTICES.length; index += 2) {
      const x = CAMERA_TRIANGLE_DOCUMENT_VERTICES[index];
      const y = CAMERA_TRIANGLE_DOCUMENT_VERTICES[index + 1];
      if (x === undefined || y === undefined) {
        throw new Error('Foundation fixture vertices are malformed.');
      }
      const point = transformPoint(camera.documentToPhysical, { x, y });
      physical.push(point.x, point.y);
    }
    this.#documentVertices = CAMERA_TRIANGLE_DOCUMENT_VERTICES;
    this.#physicalVertices = frozenNumbers(physical);
    if (size.width === 0 || size.height === 0) return;

    const ndc: number[] = [];
    for (let index = 0; index < physical.length; index += 2) {
      const x = physical[index];
      const y = physical[index + 1];
      if (x === undefined || y === undefined) {
        throw new Error('Foundation fixture physical vertices are malformed.');
      }
      ndc.push((x / size.width) * 2 - 1, 1 - (y / size.height) * 2);
    }
    this.#ndcVertices = frozenNumbers(ndc);
    this.#positionData = new Float32Array(ndc);
  }

  #createCache(generation: number): PipelineCache<unknown> {
    return new PipelineCache(generation, {
      release: () => {
        this.#livePipelines -= 1;
      },
    });
  }

  #requireActive(): void {
    if (this.#disposed) {
      throw new Error('Foundation experiment is disposed.');
    }
  }
}
