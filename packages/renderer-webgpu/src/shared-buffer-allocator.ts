export interface SharedBufferAllocatorOptions {
  readonly capacityBytes: number;
  readonly alignment: number;
  readonly generation: number;
}

export interface SharedBufferAllocation {
  readonly id: number;
  readonly offset: number;
  readonly requestedBytes: number;
  readonly allocatedBytes: number;
}

export interface SharedBufferAllocatorSnapshot {
  readonly generation: number;
  readonly disposed: boolean;
  readonly capacityBytes: number;
  readonly alignment: number;
  readonly liveAllocationCount: number;
  readonly liveRequestedBytes: number;
  readonly liveAllocatedBytes: number;
  readonly retiredBytes: number;
  readonly reservedBytes: number;
  readonly peakReservedBytes: number;
}

interface ByteRange {
  readonly offset: number;
  readonly size: number;
}

interface AllocationRecord {
  readonly descriptor: SharedBufferAllocation;
  lastUseSerial: number;
}

interface RetiredRange extends ByteRange {
  readonly lastUseSerial: number;
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function isPowerOfTwo(value: number): boolean {
  let power = 1;
  while (power < value) {
    power *= 2;
  }
  return power === value;
}

function addSafe(left: number, right: number, operation: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${operation} exceeds the safe integer range.`);
  }
  return result;
}

export class SharedBufferAllocator {
  readonly #capacityBytes: number;
  readonly #alignment: number;
  #currentGeneration: number;
  #disposed = false;
  #nextAllocationId = 1;
  #freeRanges: ByteRange[];
  readonly #liveAllocations = new Map<SharedBufferAllocation, AllocationRecord>();
  #retiredRanges: RetiredRange[] = [];
  #greatestSubmittedSerial = 0;
  #completedSerial = 0;
  #liveRequestedBytes = 0;
  #liveAllocatedBytes = 0;
  #retiredBytes = 0;
  #peakReservedBytes = 0;

  constructor(options: SharedBufferAllocatorOptions) {
    requirePositiveSafeInteger(options.capacityBytes, 'capacityBytes');
    requirePositiveSafeInteger(options.alignment, 'alignment');
    requirePositiveSafeInteger(options.generation, 'generation');
    if (!isPowerOfTwo(options.alignment)) {
      throw new RangeError('alignment must be a power of two.');
    }
    if (options.capacityBytes % options.alignment !== 0) {
      throw new RangeError('capacityBytes must be an alignment multiple.');
    }

    this.#capacityBytes = options.capacityBytes;
    this.#alignment = options.alignment;
    this.#currentGeneration = options.generation;
    this.#freeRanges = [{ offset: 0, size: options.capacityBytes }];
  }

  get capacityBytes(): number {
    return this.#capacityBytes;
  }

  get alignment(): number {
    return this.#alignment;
  }

  allocate(requestedBytes: number): SharedBufferAllocation | undefined {
    this.#requireActive();
    requirePositiveSafeInteger(requestedBytes, 'requestedBytes');

    const remainder = requestedBytes % this.#alignment;
    const padding = remainder === 0 ? 0 : this.#alignment - remainder;
    const allocatedBytes = addSafe(requestedBytes, padding, 'Aligned allocation size');
    const rangeIndex = this.#freeRanges.findIndex((range) => range.size >= allocatedBytes);
    if (rangeIndex < 0) {
      return undefined;
    }
    if (!Number.isSafeInteger(this.#nextAllocationId)) {
      throw new RangeError('Allocation identity exceeds the safe integer range.');
    }

    const range = this.#freeRanges[rangeIndex];
    if (range === undefined) {
      throw new Error('Allocator free-range metadata is inconsistent.');
    }

    const descriptor = Object.freeze({
      id: this.#nextAllocationId,
      offset: range.offset,
      requestedBytes,
      allocatedBytes,
    });
    const remainingSize = range.size - allocatedBytes;
    const remainingOffset = addSafe(range.offset, allocatedBytes, 'Free range offset');
    const nextLiveRequestedBytes = addSafe(
      this.#liveRequestedBytes,
      requestedBytes,
      'Live requested byte total',
    );
    const nextLiveAllocatedBytes = addSafe(
      this.#liveAllocatedBytes,
      allocatedBytes,
      'Live allocated byte total',
    );
    const nextReservedBytes = addSafe(
      nextLiveAllocatedBytes,
      this.#retiredBytes,
      'Reserved byte total',
    );

    if (remainingSize === 0) {
      this.#freeRanges.splice(rangeIndex, 1);
    } else {
      this.#freeRanges[rangeIndex] = { offset: remainingOffset, size: remainingSize };
    }
    this.#nextAllocationId =
      this.#nextAllocationId === Number.MAX_SAFE_INTEGER
        ? Number.POSITIVE_INFINITY
        : this.#nextAllocationId + 1;
    this.#liveAllocations.set(descriptor, { descriptor, lastUseSerial: 0 });
    this.#liveRequestedBytes = nextLiveRequestedBytes;
    this.#liveAllocatedBytes = nextLiveAllocatedBytes;
    this.#peakReservedBytes = Math.max(this.#peakReservedBytes, nextReservedBytes);
    return descriptor;
  }

  markSubmitted(
    generation: number,
    serial: number,
    allocations: readonly SharedBufferAllocation[],
  ): void {
    this.#requireActive();
    requirePositiveSafeInteger(generation, 'generation');
    requirePositiveSafeInteger(serial, 'serial');
    if (generation !== this.#currentGeneration) {
      throw new RangeError('generation must equal the allocator generation.');
    }
    if (serial <= this.#greatestSubmittedSerial) {
      throw new RangeError('serial must be strictly greater than prior submission serials.');
    }
    const records: AllocationRecord[] = [];
    const seen = new Set<SharedBufferAllocation>();
    for (const allocation of allocations) {
      if (seen.has(allocation)) {
        throw new Error('A submission cannot contain a duplicate allocation.');
      }
      seen.add(allocation);
      const record = this.#liveAllocations.get(allocation);
      if (record === undefined || record.descriptor !== allocation) {
        throw new Error('Submission contains a foreign, forged, or freed allocation.');
      }
      records.push(record);
    }

    for (const record of records) {
      record.lastUseSerial = serial;
    }
    this.#greatestSubmittedSerial = serial;
  }

  completeThrough(generation: number, serial: number): void {
    this.#requireActive();
    requirePositiveSafeInteger(generation, 'generation');
    requireNonNegativeSafeInteger(serial, 'serial');
    if (generation < this.#currentGeneration) {
      return;
    }
    if (generation > this.#currentGeneration) {
      throw new RangeError('generation cannot be newer than the allocator generation.');
    }
    if (serial > this.#greatestSubmittedSerial) {
      throw new RangeError('serial cannot exceed the greatest registered submission.');
    }
    if (serial <= this.#completedSerial) {
      return;
    }

    const stillRetired: RetiredRange[] = [];
    const reclaimed: ByteRange[] = [];
    let reclaimedBytes = 0;
    for (const range of this.#retiredRanges) {
      if (range.lastUseSerial <= serial) {
        reclaimed.push({ offset: range.offset, size: range.size });
        reclaimedBytes += range.size;
      } else {
        stillRetired.push(range);
      }
    }

    this.#retiredRanges = stillRetired;
    this.#retiredBytes -= reclaimedBytes;
    for (const range of reclaimed) {
      this.#insertFreeRange(range);
    }
    this.#completedSerial = serial;
  }

  free(allocation: SharedBufferAllocation): void {
    this.#requireActive();
    const record = this.#liveAllocations.get(allocation);
    if (record === undefined || record.descriptor !== allocation) {
      throw new Error('Cannot free a foreign, forged, or already-freed allocation.');
    }

    const { descriptor, lastUseSerial } = record;
    const nextLiveRequestedBytes = this.#liveRequestedBytes - descriptor.requestedBytes;
    const nextLiveAllocatedBytes = this.#liveAllocatedBytes - descriptor.allocatedBytes;

    this.#liveAllocations.delete(allocation);
    this.#liveRequestedBytes = nextLiveRequestedBytes;
    this.#liveAllocatedBytes = nextLiveAllocatedBytes;
    if (lastUseSerial > this.#completedSerial) {
      this.#retiredRanges.push({
        offset: descriptor.offset,
        size: descriptor.allocatedBytes,
        lastUseSerial,
      });
      this.#retiredBytes += descriptor.allocatedBytes;
    } else {
      this.#insertFreeRange({ offset: descriptor.offset, size: descriptor.allocatedBytes });
    }
  }

  advanceGeneration(nextGeneration: number): void {
    this.#requireActive();
    requirePositiveSafeInteger(nextGeneration, 'nextGeneration');
    if (nextGeneration <= this.#currentGeneration) {
      throw new RangeError('nextGeneration must be strictly greater than the current generation.');
    }

    const reclaimed = this.#retiredRanges.map(({ offset, size }) => ({ offset, size }));
    for (const record of this.#liveAllocations.values()) {
      record.lastUseSerial = 0;
    }
    for (const range of reclaimed) {
      this.#insertFreeRange(range);
    }
    this.#retiredRanges = [];
    this.#retiredBytes = 0;
    this.#greatestSubmittedSerial = 0;
    this.#completedSerial = 0;
    this.#currentGeneration = nextGeneration;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#freeRanges = [];
    this.#liveAllocations.clear();
    this.#retiredRanges = [];
    this.#greatestSubmittedSerial = 0;
    this.#completedSerial = 0;
    this.#liveRequestedBytes = 0;
    this.#liveAllocatedBytes = 0;
    this.#retiredBytes = 0;
  }

  snapshot(): SharedBufferAllocatorSnapshot {
    const reservedBytes = this.#liveAllocatedBytes + this.#retiredBytes;
    return Object.freeze({
      generation: this.#currentGeneration,
      disposed: this.#disposed,
      capacityBytes: this.#capacityBytes,
      alignment: this.#alignment,
      liveAllocationCount: this.#liveAllocations.size,
      liveRequestedBytes: this.#liveRequestedBytes,
      liveAllocatedBytes: this.#liveAllocatedBytes,
      retiredBytes: this.#retiredBytes,
      reservedBytes,
      peakReservedBytes: this.#peakReservedBytes,
    });
  }

  #requireActive(): void {
    if (this.#disposed) {
      throw new Error('SharedBufferAllocator is disposed.');
    }
  }

  #insertFreeRange(range: ByteRange): void {
    const ranges = [...this.#freeRanges, range].sort((left, right) => left.offset - right.offset);
    const coalesced: ByteRange[] = [];
    for (const candidate of ranges) {
      const previous = coalesced.at(-1);
      if (previous !== undefined && previous.offset + previous.size === candidate.offset) {
        coalesced[coalesced.length - 1] = {
          offset: previous.offset,
          size: previous.size + candidate.size,
        };
      } else {
        coalesced.push(candidate);
      }
    }
    this.#freeRanges = coalesced;
  }
}
