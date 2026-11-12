import { describe, expect, it } from 'vitest';
import {
  contains,
  E26_DRIVERS,
  E41_CARDS,
  E41_SCENARIOS,
  e26Configuration,
  e41CardsMoveSelection,
  editDragOffset,
  generateE41CardsDocument,
  loadScenarioDocument,
  panZoomCamera,
  visibility,
  worldViewport,
} from '../e26/scenarios.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';

// E41-U7c (E41 contract, section 5.6, E41-A10): the `e41-cards` scene and its scenarios, as the
// headed E26 harness runs them (tests/e26/e26-harness.spec.ts, `E26_SCENARIOS=e41`).

describe('E41-U7c e41-cards', () => {
  it('is 50 card groups at schema 8, each with a shadow, every tenth with a layer blur', () => {
    const document = generateE41CardsDocument();
    expect(document.schemaVersion).toBe(8);
    const loaded = loadScenarioDocument('e41-cards');
    const page = loaded.document.pages[0]!;
    expect(page.children).toHaveLength(E41_CARDS.count);
    const blurred = page.children.filter((id) =>
      loaded.document.nodes[id]!.effects.some((effect) => effect.kind === 'layerBlur'),
    );
    expect(blurred).toEqual(['card-00', 'card-10', 'card-20', 'card-30', 'card-40']);
    for (const id of page.children) {
      const node = loaded.document.nodes[id]!;
      expect(node.type).toBe('group');
      expect(node.effects[0]).toEqual({
        kind: 'dropShadow',
        visible: true,
        color: { r: 0, g: 0, b: 0, a: 0.25 },
        offsetX: 0,
        offsetY: 8,
        radius: 16,
      });
    }
    // Deterministic: the same document every time.
    expect(JSON.stringify(generateE41CardsDocument())).toBe(JSON.stringify(document));
  });

  it('projects one effect root per card under projectEffects', () => {
    const loaded = loadScenarioDocument('e41-cards');
    const projected = projectPage(
      loaded.document,
      loaded.pageId,
      () => null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const roots = [...projected.nodes.values()].filter(
      (node) => node.kind === 'container' && (node.effects?.length ?? 0) > 0,
    );
    expect(roots).toHaveLength(50);
    // Radius 16 is σ 8; radius 8 is σ 4.
    const first = roots.find((node) => node.id === 'card-00')!;
    expect(first.effects).toEqual([
      expect.objectContaining({ kind: 'dropShadow', sigma: 8, offsetY: 8 }),
      { kind: 'layerBlur', sigma: 4 },
    ]);
  });

  it('shows every card at the fitted camera and along the pan and zoom path', () => {
    const loaded = loadScenarioDocument('e41-cards');
    const [view, drag] = E41_SCENARIOS as [(typeof E41_SCENARIOS)[0], (typeof E41_SCENARIOS)[0]];
    expect(view).toMatchObject({
      id: 'e41-cards-view/v1',
      camera: 'fitted',
      interaction: 'pan-zoom',
      frameCeilingMs: 16.7,
    });
    expect(drag).toMatchObject({
      id: 'e41-cards-drag/v1',
      camera: 'fitted',
      interaction: 'edit-drag',
      frameCeilingMs: 16.7,
    });
    const configuration = e26Configuration(view, 2, 5, loaded);
    expect(configuration.schemaVersion).toBe(8);
    expect(configuration.drawnLeaves).toBe(150);
    const camera = configuration.camera;
    for (let t = 0; t < E26_DRIVERS.thetaPeriodMs; t += 10) {
      const seen = visibility(loaded.bounds, panZoomCamera(camera, t), 2);
      expect(seen.inside, `t ${t}`).toBe(seen.leaves);
    }
    // The dragged card stays inside the view through the drag.
    const { pressed, ids } = e41CardsMoveSelection();
    expect(ids).toEqual(['card-22']);
    const box = loaded.bounds.get(pressed)!;
    const viewport = worldViewport(camera);
    for (let t = 0; t < E26_DRIVERS.thetaPeriodMs; t += 10) {
      const offset = editDragOffset(t);
      const dx = offset.x / camera.zoom;
      const dy = offset.y / camera.zoom;
      expect(
        contains(viewport, {
          minX: box.minX + dx,
          minY: box.minY + dy,
          maxX: box.maxX + dx,
          maxY: box.maxY + dy,
        }),
      ).toBe(true);
    }
  });
});
