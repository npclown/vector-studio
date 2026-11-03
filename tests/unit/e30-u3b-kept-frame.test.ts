import { describe, expect, it } from 'vitest';
import {
  MaskPlan,
  type ClipChain,
  type ClipMaskLevel,
} from '../../packages/renderer-core/src/clip-resolution.js';
import { random } from '../support/packing-primitives.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.1, U3b-2: the mask
// plan keeps each chain's admission once its levels are planned, and assembles a level's key
// from kept parts. The twin oracle shares the mask plan, so these are checked here against the
// plan's own definition: a chain is admitted exactly when every mask level on it has a drawable
// record, and a key is the JSON of the record's fields as before.

const mask = (id: string, x: number): ClipMaskLevel =>
  Object.freeze({
    kind: 'mask',
    containerId: id,
    world: [1, 0, 0, 1, x, 0] as const,
    sourceId: `${id}-src`,
  });
const rect = (id: string, width: number) =>
  Object.freeze({
    kind: 'rect' as const,
    containerId: id,
    toLocal: [1, 0, 0, 1, -width, 0] as const,
    width,
    height: width / 2,
  });

describe('E30-U3b mask plan admission and keys', () => {
  it('admits a chain exactly when each of its mask levels has a drawable record', () => {
    const rng = random(0xe30b5);
    for (let trial = 0; trial < 200; trial += 1) {
      // A pool of levels shared by chains, as nested containers share their ancestors.
      const levels = Array.from({ length: 6 }, (_, index) =>
        rng() < 0.7 ? mask(`m${index}`, rng() * 100) : rect(`r${index}`, 5 + rng() * 40),
      );
      const bounds = levels.map(() => {
        const minX = (rng() - 0.3) * 300;
        const minY = (rng() - 0.3) * 200;
        return Object.freeze({
          minX,
          minY,
          maxX: minX + rng() * 200,
          maxY: minY + rng() * 150,
        });
      });
      const chains: ClipChain[] = Array.from({ length: 12 }, (_, index) => {
        const depth = 1 + Math.floor(rng() * levels.length);
        return Object.freeze({
          key: `c${index}`,
          levels: levels.slice(0, depth),
          bounds: bounds.slice(0, depth),
          empty: false,
        });
      });
      const covering = new Set(levels.filter(() => rng() < 0.85).map((level) => level.containerId));
      const plan = new MaskPlan({
        sourceOf: (level) =>
          covering.has(level.containerId)
            ? { source: { kind: 'mesh', nodeId: level.sourceId! }, key: level.containerId }
            : null,
        camera: { x: rng() * 50, y: rng() * 50, zoom: 0.5 + rng() * 2 },
        target: { width: 320, height: 200, devicePixelRatio: 1, sampleCount: 4 },
        // Small budgets so that some levels go over it.
        budget: 20_000 + rng() * 400_000,
      });
      const answers = new Map<ClipChain, boolean[]>();
      for (let call = 0; call < 40; call += 1) {
        const chain = chains[Math.floor(rng() * chains.length)]!;
        const list = answers.get(chain) ?? [];
        list.push(plan.admit(chain));
        answers.set(chain, list);
      }
      const drawable = new Set(plan.levels.map((record) => record.id));
      for (const [chain, list] of answers) {
        const expected = chain.levels.every(
          (level) => level.kind !== 'mask' || drawable.has(level.containerId),
        );
        for (const answer of list) expect(answer, `trial ${trial} ${chain.key}`).toBe(expected);
      }
    }
  });

  it('keys a level record with the JSON of its fields', () => {
    const outer = mask('o', 10);
    const inner = mask('i', 20);
    const chain: ClipChain = Object.freeze({
      key: 'c',
      levels: [rect('a', 60), outer, rect('r', 30), inner],
      bounds: [
        { minX: -10, minY: -10, maxX: 130, maxY: 90 },
        { minX: 0, minY: 0, maxX: 120, maxY: 80 },
        { minX: 10, minY: 5, maxX: 100, maxY: 70 },
        { minX: 20, minY: 10, maxX: 90, maxY: 60 },
      ],
      empty: false,
    });
    const camera = { x: -3.25, y: 4.5, zoom: 1.75 };
    const target = { width: 320, height: 200, devicePixelRatio: 1.5, sampleCount: 4 as const };
    const plan = new MaskPlan({
      sourceOf: (level) => ({
        source: { kind: 'mesh', nodeId: level.sourceId! },
        key: `["mesh","${level.containerId}"]`,
      }),
      camera,
      target,
    });
    expect(plan.admit(chain)).toBe(true);
    const [first, second] = plan.levels;
    for (const [record, parent] of [
      [first!, null],
      [second!, first!],
    ] as const) {
      expect(record.key).toBe(
        JSON.stringify([
          parent?.key ?? null,
          record.rects,
          record.device,
          `["mesh","${record.id}"]`,
          camera,
          target.devicePixelRatio,
          target.width,
          target.height,
          target.sampleCount,
        ]),
      );
    }
    // Each level carries the rects between its parent and itself.
    expect(first!.rects.map((r) => r.width)).toEqual([60]);
    expect(second!.rects.map((r) => r.width)).toEqual([30]);
  });
});
