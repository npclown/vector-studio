import { describe, expect, it } from 'vitest';
import {
  e26Configuration,
  generateV35CardsDocument,
  e41CardsMoveSelection,
  loadScenarioDocument,
  nodeDrawBounds,
  V35_CARDS,
  V35_SCENARIOS,
} from '../e26/scenarios.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';

// V-35 contract, V35-A10: the `v35-cards` scene and its scenarios, as the headed E26 harness
// runs them (tests/e26/e26-harness.spec.ts, `E26_SCENARIOS=v35`). Modelled on e41-u7c-cards.

describe('V35-A10 v35-cards', () => {
  it('is 50 cards, each background with three fills; multiply every fifth, screen every tenth', () => {
    expect(generateV35CardsDocument().schemaVersion).toBe(8);
    const loaded = loadScenarioDocument('v35-cards');
    expect(loaded.document.id).toBe('v35-cards');
    const ids = loaded.document.pages[0]!.children;
    expect(ids).toHaveLength(50);
    const modes = (id: string) => {
      const bg = loaded.document.nodes[`${id}-bg`]!;
      return 'fills' in bg ? bg.fills.map((fill) => fill.blendMode) : [];
    };
    ids.forEach((id, i) => {
      const card = loaded.document.nodes[id]!;
      expect(card.effects).toEqual([]);
      expect(card.blendMode).toBe(i % 10 === 0 ? 'screen' : 'passThrough');
      expect(modes(id)).toEqual(['normal', 'normal', i % 5 === 0 ? 'multiply' : 'normal']);
    });
    expect(ids.filter((_, i) => i % 5 === 0)).toHaveLength(10);
    expect(ids.filter((_, i) => i % 10 === 0)).toHaveLength(5);
    expect(JSON.stringify(generateV35CardsDocument())).toBe(
      JSON.stringify(generateV35CardsDocument()),
    );
  });

  it('gives the drag its pressed background bounds through the fill leaves', () => {
    const loaded = loadScenarioDocument('v35-cards');
    const pressed = e41CardsMoveSelection().pressed;
    // The background has three fills, so it projects as fill leaves, not a leaf of its own id.
    expect(loaded.bounds.has(pressed)).toBe(false);
    const box = nodeDrawBounds(loaded.bounds, pressed);
    expect(box).toEqual(nodeDrawBounds(loaded.bounds, `${pressed}\u0000fill0`));
    expect(box!.maxX).toBeGreaterThan(box!.minX);
    expect(nodeDrawBounds(loaded.bounds, 'missing')).toBeUndefined();
    const e41 = loadScenarioDocument('e41-cards');
    expect(nodeDrawBounds(e41.bounds, pressed)).toEqual(e41.bounds.get(pressed));
  });

  it('projects its blend roots only with the blend gate on', () => {
    const loaded = loadScenarioDocument('v35-cards');
    const roots = (blend: boolean) =>
      [
        ...projectPage(
          loaded.document,
          loaded.pageId,
          () => null,
          new Set(),
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          blend,
        ).nodes.values(),
      ].filter((node) => node.blendMode !== undefined && node.blendMode !== 'passThrough');
    expect(roots(false)).toHaveLength(0);
    const on = roots(true);
    expect(on).toHaveLength(V35_CARDS.blendRoots);
    expect(on.filter((node) => node.blendMode === 'screen')).toHaveLength(5);
    expect(on.filter((node) => node.blendMode === 'multiply')).toHaveLength(10);
  });

  it('shares the e41 cards fitted camera, both scenarios at a 16.7 ms ceiling', () => {
    const loaded = loadScenarioDocument('v35-cards');
    const [view, drag] = V35_SCENARIOS as [(typeof V35_SCENARIOS)[0], (typeof V35_SCENARIOS)[0]];
    expect(view).toMatchObject({
      id: 'v35-cards-view/v1',
      document: 'v35-cards',
      camera: 'fitted',
      interaction: 'pan-zoom',
      frameCeilingMs: 16.7,
    });
    expect(drag).toMatchObject({
      id: 'v35-cards-drag/v1',
      camera: 'fitted',
      interaction: 'edit-drag',
      frameCeilingMs: 16.7,
    });
    expect(e26Configuration(view, 2, 5, loaded).schemaVersion).toBe(8);
    expect(loaded.pageId).toBe('cards-page');
  });
});
