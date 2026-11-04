import { ResourceAccounting, type PrimitivePacket } from '@vector-studio/renderer-core';
import { describe, expect, it } from 'vitest';
import {
  bytesEqual,
  createNativePrimitiveSceneCreation,
} from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import {
  Model,
  isolationSets,
  random,
  randomScene,
  randomSet,
  target,
  twin,
} from '../support/e26-twin-scene.js';
import { nativeFixture } from '../support/p4-native-fixture.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.3, U5 (L3): the backend's
// change-only writes compare bytes in 32-bit words where both views are aligned (L3a); the oracle
// is the byte-by-byte comparison it replaced, and the mask lookup by level ID is covered by the P4
// and E22 mask pass tests, whose bind groups and calls are unchanged. L3b keeps a clip state's
// packed bytes for a record seen again as the same frozen object under the same lanes; its oracle
// is a twin scene with that reuse off, fed the same packets: the same calls and the same bytes.

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

/** A native scene on P4's recording fake device whose buffer writes keep a copy of their bytes. */
async function recordingScene(reuse: boolean) {
  const fixture = nativeFixture();
  const bytes: string[] = [];
  const queue = fixture.device.queue as unknown as {
    writeBuffer: (
      buffer: { label: string },
      offset: number,
      data: Uint8Array,
      ...rest: number[]
    ) => void;
  };
  const write = queue.writeBuffer;
  queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size?: number) => {
    const view = data.subarray(dataOffset, size === undefined ? undefined : dataOffset + size);
    bytes.push(`${buffer.label}@${offset}:${Buffer.from(view).toString('hex')}`);
    write(buffer, offset, data, dataOffset, size ?? view.byteLength);
  };
  const { scene } = await createNativePrimitiveSceneCreation(
    fixture.device,
    fixture.context,
    'bgra8unorm',
    1,
    new ResourceAccounting(),
    {
      meshPipeline: true,
      clipPipeline: true,
      paintPipeline: true,
      layerPipeline: true,
      textPipeline: true,
      sampleCount: 4,
    },
  ).result;
  scene.setTarget({ ...target, sampleCount: scene.sampleCount });
  const testing = scene as unknown as {
    reusedClipStatesForTesting: number;
    disableClipStateReuseForTesting(): void;
  };
  if (!reuse) testing.disableClipStateReuseForTesting();
  return { scene, fixture, bytes, reused: () => testing.reusedClipStatesForTesting };
}

describe('E30-U5 (L3b) kept clip state bytes', () => {
  it('issues the calls and bytes of a scene that packs every state afresh', async () => {
    let reusedTotal = 0;
    let clippedFrames = 0;
    for (const seed of [41, 42, 43, 44]) {
      const rng = random(seed);
      const model = new Model();
      randomScene(rng, model, 120);
      const { mirror, source } = twin(false);
      expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
      let camera = { x: 0, y: 0, zoom: 1 };
      const kept = await recordingScene(true);
      const fresh = await recordingScene(false);
      for (let frame = 0; frame < 90; frame += 1) {
        const step = rng();
        if (step < 0.25) {
          const set = randomSet(rng, model);
          if (set !== null) expect(mirror.applyChanges(set).status).toBe('applied');
        } else if (step < 0.3) {
          for (const set of isolationSets(model)) {
            expect(mirror.applyChanges(set).status).toBe('applied');
          }
        } else if (step < 0.6) {
          camera =
            rng() < 0.7
              ? { ...camera, x: camera.x + (rng() - 0.5) * 30, y: camera.y + (rng() - 0.5) * 30 }
              : {
                  ...camera,
                  zoom: Math.min(4, Math.max(0.25, camera.zoom * (rng() < 0.5 ? 0.8 : 1.25))),
                };
        }
        mirror.setCamera({ position: { x: camera.x, y: camera.y }, zoom: camera.zoom });
        const packet: PrimitivePacket | null = source.prepare(target);
        expect(packet, `seed ${seed} frame ${frame}`).not.toBeNull();
        if (packet!.clip !== undefined) clippedFrames += 1;
        for (const scene of [kept, fresh]) {
          scene.fixture.calls.length = 0;
          scene.bytes.length = 0;
        }
        const before = kept.reused();
        const left = kept.scene.submitPrimitivePacket(packet!);
        const right = fresh.scene.submitPrimitivePacket(packet!);
        reusedTotal += kept.reused() - before;
        expect(left.status, `seed ${seed} frame ${frame}`).toBe(right.status);
        expect(kept.fixture.calls, `seed ${seed} frame ${frame} calls`).toEqual(
          fresh.fixture.calls,
        );
        expect(kept.bytes, `seed ${seed} frame ${frame} bytes`).toEqual(fresh.bytes);
        if (left.status === 'submitted') source.acknowledge(left.receipt);
      }
      expect(fresh.reused()).toBe(0);
    }
    // The reuse is exercised, over frames that carry a clip part.
    expect(clippedFrames).toBeGreaterThan(100);
    expect(reusedTotal).toBeGreaterThan(200);
  });

  it('packs a state afresh when its record, the origin or its mask offset changes', async () => {
    // One clipped packet with a masked state, then the same packet with one input changed at a
    // time, each submitted to both scenes.
    let base: PrimitivePacket | null = null;
    for (let seed = 50; seed < 90 && base === null; seed += 1) {
      const rng = random(seed);
      const model = new Model();
      randomScene(rng, model, 300);
      const { mirror, source } = twin(false);
      expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
      mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 0.25 });
      const packet = source.prepare(target)!;
      const clip = packet.clip;
      if (
        clip !== undefined &&
        clip.states.some((record) => record.masks.length > 0) &&
        clip.states.some((record) => record.masks.length === 0)
      ) {
        base = packet;
      }
    }
    expect(base).not.toBeNull();
    const clip = base!.clip!;
    const plain = clip.states.find((record) => record.masks.length === 0)!;
    const masked = clip.states.find((record) => record.masks.length > 0)!;
    const level = clip.masks.find((entry) => entry.id === masked.masks.at(-1))!;
    const withClip = (part: Partial<NonNullable<PrimitivePacket['clip']>>): PrimitivePacket => ({
      ...base!,
      clip: Object.freeze({ ...clip, ...part }),
    });
    const widened = Object.freeze({
      ...plain,
      rects: Object.freeze(
        plain.rects.map((rect, index) =>
          index === 0 ? Object.freeze({ ...rect, width: rect.width + 1 }) : rect,
        ),
      ),
    });
    const packets = [
      base!,
      // The same record object again: kept.
      base!,
      // A new frozen record at the same index with other contents.
      withClip({
        states: Object.freeze(clip.states.map((record) => (record === plain ? widened : record))),
      }),
      base!,
      // The origin moved along x, then along y.
      withClip({ origin: Object.freeze({ x: clip.origin.x + 3, y: clip.origin.y }) }),
      base!,
      withClip({ origin: Object.freeze({ x: clip.origin.x, y: clip.origin.y - 2 }) }),
      base!,
      // The masked state's level moved by one device pixel.
      withClip({
        masks: Object.freeze(
          clip.masks.map((entry) =>
            entry === level
              ? Object.freeze({
                  ...entry,
                  device: Object.freeze({
                    ...entry.device,
                    x:
                      entry.device.x +
                      (entry.device.x + entry.device.width < target.width ? 1 : -1),
                  }),
                })
              : entry,
          ),
        ),
      }),
    ];
    const kept = await recordingScene(true);
    const fresh = await recordingScene(false);
    for (const [index, packet] of packets.entries()) {
      for (const scene of [kept, fresh]) {
        scene.fixture.calls.length = 0;
        scene.bytes.length = 0;
      }
      const reusedBefore = kept.reused();
      const left = kept.scene.submitPrimitivePacket(packet);
      const right = fresh.scene.submitPrimitivePacket(packet);
      // The original packet again keeps every state the change before it did not touch: all of
      // them after itself, all but the widened one, none after an origin move (every state).
      const keptAgain = new Map([
        [1, clip.states.length],
        [3, clip.states.length - 1],
        [5, 0],
        [7, 0],
      ]).get(index);
      if (keptAgain !== undefined) {
        expect(kept.reused() - reusedBefore, `packet ${index} kept`).toBe(keptAgain);
      }
      expect(left.status, `packet ${index}`).toBe('submitted');
      expect(right.status, `packet ${index}`).toBe('submitted');
      expect(kept.fixture.calls, `packet ${index} calls`).toEqual(fresh.fixture.calls);
      expect(kept.bytes, `packet ${index} bytes`).toEqual(fresh.bytes);
      if (index > 0) {
        expect(
          fresh.bytes.some((entry) => entry.includes('clip-states')) || index % 2 === 1,
          `packet ${index} writes`,
        ).toBe(true);
      }
    }
    expect(kept.reused()).toBeGreaterThan(0);
  });

  it('packs a state afresh when its record is not frozen', async () => {
    // Twin frames whose clip records are thawed copies: no state is kept.
    const rng = random(45);
    const model = new Model();
    randomScene(rng, model, 120);
    const { mirror, source } = twin(false);
    expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    const kept = await recordingScene(true);
    const states = new Map<number, unknown>();
    let clipped = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      const packet = source.prepare(target)!;
      const thawed: PrimitivePacket =
        packet.clip === undefined
          ? packet
          : {
              ...packet,
              clip: {
                ...packet.clip,
                states: packet.clip.states.map((record) => {
                  // The same object each frame for an index, but not frozen.
                  const copy = (states.get(record.index) ?? { ...record }) as typeof record;
                  states.set(record.index, copy);
                  return copy;
                }),
              },
            };
      if (packet.clip !== undefined) clipped += 1;
      const result = kept.scene.submitPrimitivePacket(thawed);
      if (result.status === 'submitted') source.acknowledge(result.receipt);
    }
    expect(clipped).toBeGreaterThan(0);
    expect(kept.reused()).toBe(0);
  });
});
