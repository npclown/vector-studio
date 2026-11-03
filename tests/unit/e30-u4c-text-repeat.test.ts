import { describe, expect, it } from 'vitest';
import {
  GlyphAtlasPlan,
  type AtlasFrame,
  type AtlasRequest,
  type TextReceiptPart,
} from '../../packages/renderer-core/src/text-atlas.js';
import { FakeRaster } from '../support/e28-text-harness.js';
import { random } from '../support/e26-twin-scene.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.2, U4c: a text frame with
// the same requests as the last one repeats the atlas frame when the atlas shows that planning
// would find every cluster where it was. The oracle is a second atlas that always plans, fed the
// same requests, acknowledgements, replacements and page losses; every frame and the atlas
// counters must be identical. Small pages force evictions, compactions, deferrals and omissions.

const TEXTS = [...'abcdefghijklmnopqrstuvwxyz', ' ', 'FAIL', '~e'];

function requestsOf(rng: () => number, count: number, generation: number): AtlasRequest[] {
  return Array.from({ length: count }, (_, index) =>
    Object.freeze({
      nodeId: `t${index % 7}`,
      generation,
      lang: 'en',
      fontList: 'sans-serif',
      text: TEXTS[Math.floor(rng() * TEXTS.length)]!,
      bucket: [8, 10, 12][Math.floor(rng() * 3)]!,
      phaseX: 0 as const,
    }),
  );
}

/** Every field of a frame, with sets and maps in a stable order and entries by value. */
function frameValue(frame: AtlasFrame): string {
  return JSON.stringify({
    ...frame,
    uploads: frame.uploads.map((upload) => ({ ...upload, coverage: [...upload.coverage] })),
    pages: frame.pages.map((page) => ({ ...page, keys: [...page.keys].sort(), incarnation: null })),
    added: [...frame.added.entries()].sort(),
    evicted: [...frame.evicted].sort(),
    used: [...frame.used].sort(),
  });
}

function run(seed: number, frames: number, options: { pages: number; pageSize: number }) {
  const rng = random(seed);
  const fake = { repeat: new FakeRaster(), plan: new FakeRaster() };
  const atlases = {
    repeat: new GlyphAtlasPlan(fake.repeat, options),
    plan: new GlyphAtlasPlan(fake.plan, options),
  };
  const incarnations = { repeat: [] as symbol[], plan: [] as symbol[] };
  const receipt = (which: 'repeat' | 'plan', frame: AtlasFrame): TextReceiptPart => {
    const list = incarnations[which];
    while (list.length < frame.pageCount) list.push(Symbol('page'));
    list.length = frame.pageCount;
    return { pages: [...list], clears: frame.clears.length, uploads: frame.uploads.length };
  };
  let generation = 1;
  let scene: ReadonlySet<number> = new Set([generation]);
  let requests = requestsOf(rng, 40, generation);
  let last: AtlasFrame | null = null;
  let repeated = 0;
  for (let index = 0; index < frames; index += 1) {
    const step = rng();
    if (step < 0.25) {
      requests = requestsOf(rng, 10 + Math.floor(rng() * 90), generation);
    } else if (step < 0.3) {
      generation += 1;
      scene = new Set([generation]);
      requests = requestsOf(rng, 40, generation);
    }
    // Otherwise the same requests: the case U4c repeats.
    const kept: AtlasFrame | null =
      step >= 0.3 && last !== null ? atlases.repeat.repeat(last, scene) : null;
    if (kept !== null) repeated += 1;
    const left: AtlasFrame = kept ?? atlases.repeat.plan(1, requests, true, scene);
    const right = atlases.plan.plan(1, requests, true, scene);
    expect(frameValue(left), `seed ${seed} frame ${index}`).toBe(frameValue(right));
    last = left;
    const ack = rng();
    if (ack < 0.8) {
      if (rng() < 0.05 && incarnations.repeat.length > 0) {
        // The backend lost page 0: its entries are dropped and drawn again.
        incarnations.repeat[0] = Symbol('page');
        incarnations.plan[0] = Symbol('page');
      }
      expect(atlases.repeat.acknowledge(left, receipt('repeat', left))).toBe(
        atlases.plan.acknowledge(right, receipt('plan', right)),
      );
    } else if (ack < 0.9) {
      atlases.repeat.replaced(left);
      atlases.plan.replaced(right);
    }
    // Otherwise the packet is neither acknowledged nor replaced.
    expect(atlases.repeat.peekNotices()).toEqual(atlases.plan.peekNotices());
    atlases.repeat.consumeNotices(atlases.repeat.peekNotices().length);
    atlases.plan.consumeNotices(atlases.plan.peekNotices().length);
  }
  for (const name of ['rasterCalls', 'uploads', 'evictions', 'committedPageCount'] as const) {
    expect(atlases.repeat[name], name).toBe(atlases.plan[name]);
  }
  expect(fake.repeat.requests).toEqual(fake.plan.requests);
  return repeated;
}

describe('E30-U4c text frame repeat', () => {
  it('repeats exactly the frames planning would give, over evictions and page losses', () => {
    const repeated = [
      run(1, 400, { pages: 4, pageSize: 256 }),
      run(2, 400, { pages: 2, pageSize: 64 }),
      run(3, 400, { pages: 1, pageSize: 48 }),
      run(5, 400, { pages: 1, pageSize: 96 }),
      run(4, 400, { pages: 3, pageSize: 96 }),
    ];
    // The single 48 px page is over its limit on most frames, which never repeat; every other
    // configuration repeats many frames between its evictions, compactions and deferrals.
    expect(repeated[2]).toBeGreaterThan(0);
    for (const count of [repeated[0], repeated[1], repeated[3], repeated[4]]) {
      expect(count).toBeGreaterThan(40);
    }
  });

  it('declines a frame that is not the last one planned and acknowledged', () => {
    const atlas = new GlyphAtlasPlan(new FakeRaster(), { pages: 2, pageSize: 256 });
    const scene = new Set([1]);
    const requests = requestsOf(random(9), 20, 1);
    const pages = [Symbol('page'), Symbol('page')];
    const receipt = (frame: AtlasFrame): TextReceiptPart => ({
      pages: pages.slice(0, frame.pageCount),
      clears: frame.clears.length,
      uploads: frame.uploads.length,
    });
    const first = atlas.plan(1, requests, true, scene);
    // Not acknowledged: its uploads are not committed.
    expect(atlas.repeat(first, scene)).toBeNull();
    atlas.acknowledge(first, receipt(first));
    const second = atlas.repeat(first, scene)!;
    expect(second).not.toBeNull();
    expect(second.frame).toBe(first.frame + 1);
    expect(second.uploads).toEqual([]);
    // Not acknowledged, and then not the last planned.
    expect(atlas.repeat(second, scene)).toBeNull();
    atlas.acknowledge(second, receipt(second));
    expect(atlas.repeat(first, scene)).toBeNull();
    expect(atlas.repeat(second, new Set([1]))).toBeNull();
    const third = atlas.repeat(second, scene)!;
    expect(third).not.toBeNull();
    atlas.acknowledge(third, receipt(third));
    // Acknowledged, but another frame was planned since.
    atlas.plan(1, requests.slice(1), true, scene);
    expect(atlas.repeat(third, scene)).toBeNull();
  });
});
