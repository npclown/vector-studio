// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U4, V32-H1 and V32-P2: the react
// image source port over injected `createImageBitmap`, canvas readback and task scheduling.
import { describe, expect, it } from 'vitest';
import type { ImageAsset } from '@vector-studio/editor-core';
import {
  createImageSource,
  decodeSize,
  planDecode,
  type ImageSourceHost,
} from '../../packages/react/src/image-source.js';

const be32 = (value: number) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

/** A PNG header (and nothing after it) for a `width × height` image, as an asset. */
function asset(width: number, height: number, declared = { width, height }): ImageAsset {
  const bytes = Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return { mimeType: 'image/png', ...declared, data: Buffer.from(bytes).toString('base64') };
}

type Fake = Readonly<{
  host: ImageSourceHost;
  /** The options of each `createImageBitmap` call. */
  calls: Record<string, unknown>[];
  /** Runs the scheduled tasks, returning how many ran. */
  tasks(): number;
  fail: { next: boolean };
  closed: number[];
}>;

function fake(): Fake {
  const calls: Record<string, unknown>[] = [];
  const queue: (() => void)[] = [];
  const fail = { next: false };
  const closed: number[] = [];
  const host: ImageSourceHost = {
    createImageBitmap(_blob, options) {
      calls.push({ ...options });
      if (fail.next) return Promise.reject(new Error('decode'));
      const width = (options.resizeWidth as number | undefined) ?? 0;
      const height = (options.resizeHeight as number | undefined) ?? 0;
      // Without a resize the fake decodes at the size the test set through `sizes`.
      const size = width > 0 ? { width, height } : { ...nextSize };
      return Promise.resolve({ ...size, close: () => closed.push(size.width) });
    },
    readPixels: (bitmap) => new Uint8Array(4 * bitmap.width * bitmap.height).fill(7),
    schedule(run) {
      queue.push(run);
      return () => {
        queue.splice(queue.indexOf(run), 1);
      };
    },
  };
  return {
    host,
    calls,
    fail,
    closed,
    tasks() {
      const run = queue.splice(0);
      for (const task of run) task();
      return run.length;
    },
  };
}

let nextSize = { width: 64, height: 32 };

/** Lets the decode promise chains settle. */
const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

describe('V32-H1 image source', () => {
  it('answers unknown-image for a key the document does not hold', () => {
    const f = fake();
    const source = createImageSource(() => ({}), { host: f.host });
    expect(source.request('0'.repeat(64))).toEqual({ status: 'failed', reason: 'unknown-image' });
    const withTable = createImageSource(() => ({ images: { a: asset(4, 4) } }), { host: f.host });
    expect(withTable.request('constructor')).toEqual({ status: 'failed', reason: 'unknown-image' });
    expect(f.calls).toEqual([]);
  });

  it('is pending first, then ready with RGBA pixels, notified on a task', async () => {
    nextSize = { width: 64, height: 32 };
    const f = fake();
    const source = createImageSource(() => ({ images: { k: asset(64, 32) } }), { host: f.host });
    const heard: (readonly string[])[] = [];
    source.subscribe((keys) => heard.push(keys));
    expect(source.request('k')).toEqual({ status: 'pending' });
    // A second request of a pending key neither decodes again nor notifies.
    expect(source.request('k')).toEqual({ status: 'pending' });
    expect(heard).toEqual([]);
    await settle();
    // The change is recorded, but the listener runs on a task, not before.
    expect(heard).toEqual([]);
    expect(f.tasks()).toBe(1);
    expect(heard).toEqual([['k']]);
    const result = source.request('k');
    expect(result).toMatchObject({ status: 'ready', width: 64, height: 32 });
    if (result.status === 'ready') expect(result.pixels.length).toBe(4 * 64 * 32);
    expect(f.calls).toHaveLength(1);
    // The V32-H1 decode options, and no resize for an image within 4096.
    expect(f.calls[0]).toEqual({
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
      imageOrientation: 'from-image',
    });
    expect(f.closed).toEqual([64]);
  });

  it('never runs a listener inside request, and a throwing listener does not stop the others', async () => {
    nextSize = { width: 8, height: 8 };
    const f = fake();
    const source = createImageSource(() => ({ images: { k: asset(8, 8) } }), { host: f.host });
    let inside = false;
    let heard = 0;
    source.subscribe(() => {
      if (inside) heard += 100;
      throw new Error('listener');
    });
    const unsubscribe = source.subscribe(() => (heard += 1));
    inside = true;
    source.request('k');
    inside = false;
    await settle();
    f.tasks();
    expect(heard).toBe(1);
    unsubscribe();
  });

  it('batches the keys that changed before the task into one notification', async () => {
    nextSize = { width: 8, height: 8 };
    const f = fake();
    const source = createImageSource(() => ({ images: { a: asset(8, 8), b: asset(8, 8) } }), {
      host: f.host,
    });
    const heard: (readonly string[])[] = [];
    source.subscribe((keys) => heard.push(keys));
    source.request('a');
    source.request('b');
    await settle();
    expect(f.tasks()).toBe(1);
    expect(heard).toEqual([['a', 'b']]);
  });

  it('downscales an image above 4096 per side, keeping the aspect', async () => {
    const f = fake();
    const source = createImageSource(() => ({ images: { k: asset(8192, 2048) } }), {
      host: f.host,
    });
    source.request('k');
    await settle();
    expect(f.calls[0]).toMatchObject({ resizeWidth: 4096, resizeHeight: 1024 });
    f.tasks();
    expect(source.request('k')).toMatchObject({ status: 'ready', width: 4096, height: 1024 });
    expect(decodeSize(8192, 2048)).toEqual({ width: 4096, height: 1024 });
    expect(decodeSize(5000, 3)).toEqual({ width: 4096, height: 2 });
    expect(decodeSize(4096, 4096)).toEqual({ width: 4096, height: 4096 });
  });

  it('fails too-large above the V32-M1 caps before any decode', async () => {
    const f = fake();
    const source = createImageSource(
      () => ({ images: { wide: asset(40000, 10), many: asset(9000, 9000) } }),
      { host: f.host },
    );
    source.request('wide');
    source.request('many');
    await settle();
    expect(f.calls).toEqual([]);
    expect(source.request('wide')).toEqual({ status: 'failed', reason: 'too-large' });
    expect(source.request('many')).toEqual({ status: 'failed', reason: 'too-large' });
  });

  it('fails decode-failed when the header disagrees with the declared size, type or bytes', async () => {
    const f = fake();
    const bad = asset(10, 10, { width: 11, height: 10 });
    const wrongType: ImageAsset = { ...asset(10, 10), mimeType: 'image/gif' };
    const junk: ImageAsset = { mimeType: 'image/png', width: 1, height: 1, data: 'AAAA' };
    const source = createImageSource(() => ({ images: { bad, wrongType, junk } }), {
      host: f.host,
    });
    for (const key of ['bad', 'wrongType', 'junk']) source.request(key);
    await settle();
    expect(f.calls).toEqual([]);
    for (const key of ['bad', 'wrongType', 'junk']) {
      expect(source.request(key)).toEqual({ status: 'failed', reason: 'decode-failed' });
    }
  });

  it('counts a decode that throws, and notifies the failure', async () => {
    const f = fake();
    f.fail.next = true;
    const source = createImageSource(() => ({ images: { k: asset(8, 8) } }), { host: f.host });
    const heard: (readonly string[])[] = [];
    source.subscribe((keys) => heard.push(keys));
    source.request('k');
    await settle();
    f.tasks();
    expect(heard).toEqual([['k']]);
    expect(source.request('k')).toEqual({ status: 'failed', reason: 'decode-failed' });
  });

  it('keeps at most the budget of pixels, dropping the least recently requested first', async () => {
    nextSize = { width: 10, height: 10 };
    const f = fake();
    // 400 bytes per image: the budget holds two.
    const images = { a: asset(10, 10), b: asset(10, 10), c: asset(10, 10) };
    const source = createImageSource(() => ({ images }), { host: f.host, cacheBytes: 800 });
    const heard: (readonly string[])[] = [];
    source.subscribe((keys) => heard.push(keys));
    source.request('a');
    source.request('b');
    await settle();
    f.tasks();
    expect(source.request('a').status).toBe('ready');
    expect(source.request('b').status).toBe('ready');
    // `a` was requested before `b`, so it is the oldest; requesting it again makes `b` oldest.
    source.request('a');
    source.request('c');
    await settle();
    f.tasks();
    expect(heard.at(-1)).toEqual(['c']);
    expect(source.request('a').status).toBe('ready');
    expect(source.request('c').status).toBe('ready');
    // `b` was dropped: it is pending again and decodes again (4 decodes in all before this).
    const decodes = f.calls.length;
    expect(source.request('b')).toEqual({ status: 'pending' });
    await settle();
    expect(f.calls.length).toBe(decodes + 1);
    f.tasks();
    expect(heard.at(-1)).toEqual(['b']);
    expect(source.request('b').status).toBe('ready');
  });

  it('answers failed and keeps no timer after dispose', async () => {
    nextSize = { width: 8, height: 8 };
    const f = fake();
    const source = createImageSource(() => ({ images: { k: asset(8, 8) } }), { host: f.host });
    const heard: unknown[] = [];
    source.subscribe((keys) => heard.push(keys));
    source.request('k');
    await settle();
    source.dispose();
    expect(f.tasks()).toBe(0);
    expect(heard).toEqual([]);
    expect(source.request('k')).toEqual({ status: 'failed', reason: 'unknown-image' });
  });

  it('fails decode-failed when the bitmap is not the size the header predicts', async () => {
    // The header says 8 × 8; the decoder (a GIF frame, an EXIF turn) made a 9 × 8 bitmap.
    nextSize = { width: 9, height: 8 };
    const f = fake();
    const source = createImageSource(() => ({ images: { k: asset(8, 8) } }), { host: f.host });
    source.request('k');
    await settle();
    f.tasks();
    expect(source.request('k')).toEqual({ status: 'failed', reason: 'decode-failed' });
    expect(f.closed).toEqual([9]);
  });

  it('runs at most three decodes at once and the rest in turn', async () => {
    nextSize = { width: 8, height: 8 };
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const f = fake();
    const host: ImageSourceHost = {
      ...f.host,
      createImageBitmap: () => {
        active += 1;
        peak = Math.max(peak, active);
        return new Promise((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve({ width: 8, height: 8 });
          });
        });
      },
    };
    const images = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, asset(8, 8)]));
    const source = createImageSource(() => ({ images }), { host });
    for (const k of Object.keys(images)) expect(source.request(k)).toEqual({ status: 'pending' });
    await settle();
    expect(releases).toHaveLength(3);
    for (const release of releases.splice(0)) release();
    await settle();
    expect(releases).toHaveLength(2);
    for (const release of releases.splice(0)) release();
    await settle();
    expect(peak).toBe(3);
    expect(source.request('e').status).toBe('ready');
  });

  it('names the implementation and the port version', () => {
    const source = createImageSource(() => ({}), { host: fake().host });
    expect(source.portVersion).toBe(0);
    expect(source.operationId).toBe('create-image-bitmap/v0');
  });
});

describe('V32-H1 and V32-E4 decode plan', () => {
  it('refuses before any decode what the caps or the declared size forbid', () => {
    expect(planDecode(asset(20000, 20000))).toEqual({ ok: false, reason: 'too-large' });
    expect(planDecode(asset(8, 8, { width: 9, height: 8 }))).toEqual({
      ok: false,
      reason: 'decode-failed',
    });
    expect(planDecode({ ...asset(8, 8), data: 'bm90IGFuIGltYWdl' })).toEqual({
      ok: false,
      reason: 'decode-failed',
    });
    expect(planDecode({ ...asset(8, 8), data: '%%%' })).toEqual({
      ok: false,
      reason: 'decode-failed',
    });
  });

  it('plans the downscaled size and the H1 options', () => {
    const plan = planDecode(asset(8000, 4000));
    expect(plan).toMatchObject({ ok: true, width: 4096, height: 2048 });
    if (plan.ok) expect(plan.options).toMatchObject({ resizeWidth: 4096, resizeQuality: 'high' });
  });
});
