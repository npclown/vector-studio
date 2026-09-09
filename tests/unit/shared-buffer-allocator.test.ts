import {
  SharedBufferAllocator,
  type SharedBufferAllocation,
} from '../../packages/renderer-webgpu/src/shared-buffer-allocator.js';
import { ResourceAccounting } from '@vector-studio/renderer-core';
import { describe, expect, it } from 'vitest';

function allocator(capacityBytes = 64, alignment = 8, generation = 1): SharedBufferAllocator {
  return new SharedBufferAllocator({ capacityBytes, alignment, generation });
}

describe('SharedBufferAllocator construction and allocation', () => {
  it('validates fixed-capacity constructor values', () => {
    expect(() => allocator(0)).toThrow(RangeError);
    expect(() => allocator(64, 0)).toThrow(RangeError);
    expect(() => allocator(64, 3)).toThrow(RangeError);
    expect(() => allocator(66, 8)).toThrow(RangeError);
    expect(() => allocator(64, 8, 0)).toThrow(RangeError);
    expect(() => allocator(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(RangeError);
  });

  it('pads allocations, keeps ranges disjoint, and returns immutable owned snapshots', () => {
    const subject = allocator();
    const first = subject.allocate(1);
    const second = subject.allocate(9);
    const third = subject.allocate(8);

    expect(first).toEqual({ id: 1, offset: 0, requestedBytes: 1, allocatedBytes: 8 });
    expect(second).toEqual({ id: 2, offset: 8, requestedBytes: 9, allocatedBytes: 16 });
    expect(third).toEqual({ id: 3, offset: 24, requestedBytes: 8, allocatedBytes: 8 });
    expect(Object.isFrozen(first)).toBe(true);

    const snapshot = subject.snapshot();
    expect(snapshot).toEqual({
      generation: 1,
      disposed: false,
      capacityBytes: 64,
      alignment: 8,
      liveAllocationCount: 3,
      liveRequestedBytes: 18,
      liveAllocatedBytes: 32,
      retiredBytes: 0,
      reservedBytes: 32,
      peakReservedBytes: 32,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('keeps reserved subranges distinct from one full-capacity resource record', () => {
    const subject = allocator();
    const accounting = new ResourceAccounting();
    accounting.track('shared-buffer-fixture', { category: 'buffer', size: subject.capacityBytes });

    const allocation = subject.allocate(9)!;
    subject.markSubmitted(1, 1, [allocation]);
    subject.free(allocation);

    const allocationSnapshot = subject.snapshot();
    const resourceSnapshot = accounting.snapshot();
    expect(allocationSnapshot.reservedBytes).toBe(
      allocationSnapshot.liveAllocatedBytes + allocationSnapshot.retiredBytes,
    );
    expect(allocationSnapshot.reservedBytes).toBe(16);
    expect(resourceSnapshot).toMatchObject({ created: 1, live: 1, liveBytes: 64 });
    expect(resourceSnapshot.liveBytes).toBe(subject.capacityBytes);
  });

  it('uses lowest-address first fit and coalesces adjacent reclaimed ranges', () => {
    const subject = allocator();
    const first = subject.allocate(8);
    const second = subject.allocate(16);
    const third = subject.allocate(8);
    const fourth = subject.allocate(32);

    expect([first?.offset, second?.offset, third?.offset, fourth?.offset]).toEqual([0, 8, 24, 32]);
    expect(subject.allocate(1)).toBeUndefined();

    subject.free(first!);
    subject.free(third!);
    expect(subject.allocate(16)).toBeUndefined();

    subject.free(second!);
    const coalesced = subject.allocate(24);
    expect(coalesced?.offset).toBe(0);
  });

  it('rejects invalid requests and aligned-size overflow without mutation', () => {
    const subject = allocator(Number.MAX_SAFE_INTEGER - 1, 2);
    const before = subject.snapshot();

    for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => subject.allocate(invalid)).toThrow(RangeError);
    }
    expect(() => subject.allocate(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(subject.snapshot()).toEqual(before);
  });

  it('keeps arithmetic exact near the safe-integer limit', () => {
    const subject = allocator(Number.MAX_SAFE_INTEGER, 1);
    const large = subject.allocate(Number.MAX_SAFE_INTEGER - 1);
    const tail = subject.allocate(1);

    expect(large).toMatchObject({ offset: 0, allocatedBytes: Number.MAX_SAFE_INTEGER - 1 });
    expect(tail).toMatchObject({ offset: Number.MAX_SAFE_INTEGER - 1, allocatedBytes: 1 });
    expect(subject.snapshot().reservedBytes).toBe(Number.MAX_SAFE_INTEGER);

    subject.free(large!);
    subject.free(tail!);
    expect(subject.allocate(Number.MAX_SAFE_INTEGER)?.offset).toBe(0);

    const largeAlignment = 2 ** 52;
    const aligned = allocator(largeAlignment, largeAlignment).allocate(1);
    expect(aligned).toMatchObject({ offset: 0, requestedBytes: 1, allocatedBytes: largeAlignment });
  });
});

describe('SharedBufferAllocator descriptor ownership', () => {
  it('rejects forged, foreign, and double-freed descriptors without mutation', () => {
    const subject = allocator();
    const other = allocator();
    const allocation = subject.allocate(8)!;
    const foreign = other.allocate(8)!;
    const forged = Object.freeze({ ...allocation });
    const before = subject.snapshot();

    expect(() => subject.free(foreign)).toThrow(Error);
    expect(() => subject.free(forged)).toThrow(Error);
    expect(subject.snapshot()).toEqual(before);

    subject.free(allocation);
    const after = subject.snapshot();
    expect(() => subject.free(allocation)).toThrow(Error);
    expect(subject.snapshot()).toEqual(after);
  });
});

describe('SharedBufferAllocator submission lifetime', () => {
  it('delays reuse through the last registered use across multiple submissions', () => {
    const subject = allocator(32);
    const allocation = subject.allocate(8)!;
    subject.allocate(8);

    subject.markSubmitted(1, 2, [allocation]);
    subject.markSubmitted(1, 5, [allocation]);
    subject.free(allocation);

    expect(subject.snapshot()).toMatchObject({ retiredBytes: 8, reservedBytes: 16 });
    expect(subject.allocate(16)?.offset).toBe(16);
    expect(subject.allocate(8)).toBeUndefined();

    subject.completeThrough(1, 2);
    subject.completeThrough(1, 4);
    expect(subject.allocate(8)).toBeUndefined();

    subject.completeThrough(1, 5);
    expect(subject.allocate(8)?.offset).toBe(0);
  });

  it('handles cumulative out-of-order completion and immediately reuses completed uses', () => {
    const subject = allocator(32);
    const first = subject.allocate(8)!;
    const second = subject.allocate(8)!;
    subject.markSubmitted(1, 2, [first]);
    subject.markSubmitted(1, 5, [second]);

    subject.completeThrough(1, 4);
    subject.completeThrough(1, 2);
    subject.free(first);
    subject.free(second);

    expect(subject.snapshot().retiredBytes).toBe(8);
    expect(subject.allocate(8)?.offset).toBe(0);
    subject.completeThrough(1, 5);
    expect(subject.allocate(8)?.offset).toBe(8);
  });

  it('validates an entire submission batch atomically', () => {
    const subject = allocator(32);
    const first = subject.allocate(8)!;
    const second = subject.allocate(8)!;
    const forged = Object.freeze({ ...first }) as SharedBufferAllocation;
    const before = subject.snapshot();

    expect(() => subject.markSubmitted(1, 1, [first, forged])).toThrow(Error);
    expect(() => subject.markSubmitted(1, 1, [first, first])).toThrow(Error);
    expect(() => subject.markSubmitted(2, 1, [first])).toThrow(RangeError);
    expect(subject.snapshot()).toEqual(before);

    subject.free(first);
    expect(subject.snapshot().retiredBytes).toBe(0);
    expect(() => subject.completeThrough(1, 1)).toThrow(RangeError);
    subject.markSubmitted(1, 1, [second]);
  });

  it('rejects a retired descriptor without advancing submission state', () => {
    const subject = allocator();
    const retired = subject.allocate(8)!;
    const live = subject.allocate(8)!;
    subject.markSubmitted(1, 1, [retired]);
    subject.free(retired);
    const before = subject.snapshot();

    expect(() => subject.markSubmitted(1, 2, [retired])).toThrow(Error);
    expect(subject.snapshot()).toEqual(before);
    subject.markSubmitted(1, 2, [live]);
  });

  it('rejects invalid or non-increasing serials without changing registered use', () => {
    const subject = allocator();
    const allocation = subject.allocate(8)!;
    subject.markSubmitted(1, 2, [allocation]);

    expect(() => subject.markSubmitted(1, 2, [allocation])).toThrow(RangeError);
    expect(() => subject.markSubmitted(1, 1, [allocation])).toThrow(RangeError);
    expect(() => subject.markSubmitted(1, Number.MAX_SAFE_INTEGER + 1, [allocation])).toThrow(
      RangeError,
    );
    expect(() => subject.completeThrough(1, 3)).toThrow(RangeError);
    expect(() => subject.completeThrough(2, 0)).toThrow(RangeError);

    subject.free(allocation);
    expect(subject.snapshot().retiredBytes).toBe(8);
  });
});

describe('SharedBufferAllocator generation and disposal', () => {
  it('retains live logical ranges and releases retired ranges across generation loss', () => {
    const subject = allocator(24);
    const live = subject.allocate(8)!;
    const retired = subject.allocate(8)!;
    subject.markSubmitted(1, 3, [live, retired]);
    subject.free(retired);

    subject.advanceGeneration(2);
    expect(subject.snapshot()).toMatchObject({
      generation: 2,
      liveAllocationCount: 1,
      liveAllocatedBytes: 8,
      retiredBytes: 0,
      reservedBytes: 8,
      peakReservedBytes: 16,
    });
    expect(subject.allocate(8)?.offset).toBe(8);

    subject.markSubmitted(2, 1, [live]);
    subject.completeThrough(1, 3);
    subject.free(live);
    expect(subject.snapshot().retiredBytes).toBe(8);
    subject.completeThrough(2, 1);
    expect(subject.allocate(8)?.offset).toBe(0);
  });

  it('rejects invalid generation changes and old-generation submissions atomically', () => {
    const subject = allocator();
    const allocation = subject.allocate(8)!;
    const before = subject.snapshot();

    for (const generation of [0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => subject.advanceGeneration(generation)).toThrow(RangeError);
    }
    expect(subject.snapshot()).toEqual(before);

    subject.advanceGeneration(2);
    expect(() => subject.markSubmitted(1, 1, [allocation])).toThrow(RangeError);
    subject.markSubmitted(2, 1, [allocation]);
  });

  it('is terminal after idempotent disposal while preserving configuration and peak history', () => {
    const subject = allocator();
    const allocation = subject.allocate(9)!;
    subject.markSubmitted(1, 1, [allocation]);
    subject.free(allocation);
    subject.dispose();
    subject.dispose();

    expect(subject.snapshot()).toEqual({
      generation: 1,
      disposed: true,
      capacityBytes: 64,
      alignment: 8,
      liveAllocationCount: 0,
      liveRequestedBytes: 0,
      liveAllocatedBytes: 0,
      retiredBytes: 0,
      reservedBytes: 0,
      peakReservedBytes: 16,
    });
    expect(() => subject.allocate(1)).toThrow(Error);
    expect(() => subject.free(allocation)).toThrow(Error);
    expect(() => subject.markSubmitted(1, 2, [])).toThrow(Error);
    expect(() => subject.completeThrough(1, 1)).toThrow(Error);
    expect(() => subject.advanceGeneration(2)).toThrow(Error);
  });
});
