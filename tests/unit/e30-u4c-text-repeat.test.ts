import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type { PrimitiveTarget } from '../../packages/renderer-core/src/primitive-packet.js';
import { packingCountsForTesting } from '../../packages/renderer-core/src/primitive-scene-source.js';
import {
  GlyphAtlasPlan,
  type AtlasFrame,
  type AtlasRequest,
  type TextReceiptPart,
} from '../../packages/renderer-core/src/text-atlas.js';
import { FakeRaster } from '../support/e28-text-harness.js';
import {
  identity,
  normalizer,
  random,
  target,
  textReceipts,
  twin,
} from '../support/e26-twin-scene.js';

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

/** A text leaf of `count` clusters, 8 units apart from x = `x`. */
function line(id: string, x: number, count: number): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, x, 100],
    visible: true,
    opacity: 1,
    kind: 'text',
    generation: 0,
    lang: 'en',
    runs: [
      {
        fontList: 'sans-serif',
        size: 12,
        color: { r: 0, g: 0, b: 0, a: 1 },
        clusters: Array.from({ length: count }, (_, index) => ({
          text: TEXTS[index % 26]!,
          x: index * 8,
          y: 10,
          advance: 8,
        })),
      },
    ],
  };
}

/** The twin sources (E26-U5c) with text receipts: the incremental source and the oracle. */
function sources(nodes: RenderNodeSnapshot[]) {
  const pair = { incremental: twin(false), oracle: twin(true) };
  const receipts = { incremental: textReceipts(), oracle: textReceipts() };
  const normalize = { incremental: normalizer(), oracle: normalizer() };
  let revision = 1;
  for (const { mirror } of [pair.incremental, pair.oracle]) {
    mirror.replaceSnapshot({
      identity,
      revision,
      nodes,
      rootOrder: nodes.filter((n) => n.parentId === null).map((n) => n.id),
    });
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  }
  const frame = (frameTarget: PrimitiveTarget = target) => {
    const before = packingCountsForTesting(pair.incremental.source).text;
    const left = pair.incremental.source.prepare(frameTarget)!;
    const right = pair.oracle.source.prepare(frameTarget)!;
    expect(normalize.incremental(left)).toBe(normalize.oracle(right));
    pair.incremental.source.acknowledge(receipts.incremental.receipt(left));
    pair.oracle.source.acknowledge(receipts.oracle.receipt(right));
    const after = packingCountsForTesting(pair.incremental.source).text;
    return {
      repeated: after.repeated - before.repeated,
      planned: after.planned - before.planned,
      pages: left.text?.pageCount ?? 0,
      instances: left.text?.instances,
    };
  };
  const apply = (set: {
    updated?: RenderNodeSnapshot[];
    removed?: string[];
    rootOrder?: string[];
  }) => {
    revision += 1;
    for (const { mirror } of [pair.incremental, pair.oracle]) {
      const status = mirror.applyChanges({
        identity,
        revision,
        baseRevision: revision - 1,
        inserted: [],
        updated: set.updated ?? [],
        removed: set.removed ?? [],
        orders: set.rootOrder === undefined ? [] : [{ parentId: null, children: set.rootOrder }],
      }).status;
      expect(status).toBe('applied');
    }
  };
  const pan = (x: number) => {
    for (const { mirror } of [pair.incremental, pair.oracle]) {
      mirror.setCamera({ position: { x, y: 0 }, zoom: 1 });
    }
  };
  return { frame, apply, pan };
}

describe('E30-U4c source text frames', () => {
  it('plans again when the target size or DPR changes under the same drawn leaves', () => {
    // A line across the view's right edge: the leaf stays drawn, its clusters do not.
    const { frame } = sources([line('t', 0, 80)]);
    frame();
    frame();
    const still = frame();
    expect(still).toMatchObject({ repeated: 1, planned: 0 });
    // No two packets share one record buffer.
    expect(still.instances).not.toBe(frame().instances);
    const wider = { ...target, surfaceRevision: 2, width: 800 };
    expect(frame(wider)).toMatchObject({ repeated: 0, planned: 1 });
    expect(frame(wider)).toMatchObject({ repeated: 1, planned: 0 });
    const sharper = { ...wider, surfaceRevision: 3, devicePixelRatio: 1 };
    expect(frame(sharper)).toMatchObject({ repeated: 0, planned: 1 });
    expect(frame(sharper)).toMatchObject({ repeated: 1, planned: 0 });
  });

  it('releases the pages when the scene stops holding text, with nothing drawn before', () => {
    // A half-opaque container makes a layer, whose pass interns the drawn leaves: the empty
    // array is the same object before and after the text node goes.
    const group: RenderNodeSnapshot = {
      id: 'g',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 0.5,
      kind: 'container',
      clip: null,
      children: ['r'],
    };
    const rect: RenderNodeSnapshot = {
      id: 'r',
      parentId: 'g',
      transform: [1, 0, 0, 1, 5_010, 300],
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 20, height: 20, cornerRadii: [0, 0, 0, 0] },
      style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
    };
    const { frame, apply, pan } = sources([line('t', 0, 20), group, rect]);
    frame();
    expect(frame().pages).toBeGreaterThan(0);
    // Out of view: nothing is drawn, the pages are kept.
    pan(5_000);
    frame();
    expect(frame()).toMatchObject({ repeated: 1 });
    // No text node left: the same (empty) drawn leaves, but the pages are released.
    apply({ removed: ['t'], rootOrder: ['g'] });
    expect(frame()).toMatchObject({ repeated: 0, planned: 1, pages: 0 });
  });
});
