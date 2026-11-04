import { describe, expect, it } from 'vitest';
import { bytesEqual } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import { random } from '../support/e26-twin-scene.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.3, U5 (L3): the backend's
// change-only writes compare bytes in 32-bit words where both views are aligned. The oracle is the
// byte-by-byte comparison it replaced; the mask lookup by level ID is covered by the P4 and E22
// mask pass tests, whose bind groups and calls are unchanged.

const reference = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

describe('E30-U5 (L3) backend byte equality', () => {
  it('agrees with the byte-by-byte comparison', () => {
    const rng = random(30);
    let equal = 0;
    for (let trial = 0; trial < 4000; trial += 1) {
      const length = Math.floor(rng() * 70);
      const backing = new Uint8Array(length + 8);
      for (let index = 0; index < backing.length; index += 1) {
        backing[index] = Math.floor(rng() * 4);
      }
      // Offsets 0 to 3 on both sides: aligned, unaligned and mixed views, some over one ArrayBuffer.
      const leftOffset = Math.floor(rng() * 4);
      const left = new Uint8Array(backing.buffer, leftOffset, length);
      let right: Uint8Array;
      const kind = rng();
      if (kind < 0.4) {
        const copy = new Uint8Array(length + 4);
        const offset = Math.floor(rng() * 4);
        copy.set(left, offset);
        right = copy.subarray(offset, offset + length);
      } else if (kind < 0.7) {
        const shifted = new Uint8Array(length + 4);
        const offset = Math.floor(rng() * 4);
        shifted.set(left, offset);
        right = shifted.subarray(offset, offset + length);
        if (length > 0) right[Math.floor(rng() * length)]! ^= 1 << Math.floor(rng() * 8);
      } else if (kind < 0.85) {
        right = new Uint8Array(Math.floor(rng() * 70));
      } else {
        right = new Uint8Array(backing.buffer, Math.floor(rng() * 4), length);
      }
      const expected = reference(left, right);
      expect(bytesEqual(left, right), `trial ${trial}`).toBe(expected);
      expect(bytesEqual(right, left), `trial ${trial}, swapped`).toBe(expected);
      if (expected) equal += 1;
    }
    // Both outcomes are exercised.
    expect(equal).toBeGreaterThan(500);
    expect(equal).toBeLessThan(3500);
  });

  it('finds a difference in every byte of a word and in the tail', () => {
    for (const length of [1, 3, 4, 5, 8, 1044, 1047]) {
      const left = new Uint8Array(length).map((_, index) => index & 0xff);
      expect(bytesEqual(left, left.slice())).toBe(true);
      expect(bytesEqual(left, left)).toBe(true);
      for (let index = 0; index < length; index += 1) {
        const right = left.slice();
        right[index]! ^= 0x80;
        expect(bytesEqual(left, right), `length ${length}, byte ${index}`).toBe(false);
      }
    }
  });
});
