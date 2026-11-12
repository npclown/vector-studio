import { describe, expect, it } from 'vitest';
import type { NodeV8 } from '@vector-studio/model';
import {
  contains,
  E26_DRIVERS,
  E26_VIEWPORT,
  E41_CARDS,
  e26Configuration,
  e41CardsMoveSelection,
  editDragOffset,
  generateV36GlassDocument,
  loadScenarioDocument,
  nodeDrawBounds,
  panZoomCamera,
  V36_GLASS,
  V36_SCENARIOS,
  visibility,
  worldViewport,
} from '../e26/scenarios.js';
import { DEFAULT_INNER_SHADOW } from '../../packages/editor-core/src/effect-commands.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { backdropMargin } from '../../packages/renderer-core/src/effect-plan.js';
import type { PrimitivePacket } from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { backgroundBlurNested, effectRows } from '../../packages/ui/src/effects-model.js';

// V-36 contract, V36-A10: the `v36-glass` scene and its scenarios, as the headed E26 harness runs
// them (tests/e26/e26-harness.spec.ts, `E26_SCENARIOS=v36`). Modelled on v35-cards.test.ts.

const glass = (i: number) => i % V36_GLASS.glassEvery === 0;

function project(effects: boolean | 'v1') {
  const loaded = loadScenarioDocument('v36-glass');
  return projectPage(
    loaded.document,
    loaded.pageId,
    () => null,
    new Set(),
    undefined,
    undefined,
    undefined,
    undefined,
    effects,
    true,
  );
}

describe('V36-A10 v36-glass', () => {
  it('is the e41 cards with every fifth card a 30 % glass card, deterministic', () => {
    expect(generateV36GlassDocument().schemaVersion).toBe(8);
    const loaded = loadScenarioDocument('v36-glass');
    const e41 = loadScenarioDocument('e41-cards');
    expect(loaded.document.id).toBe('v36-glass');
    const ids = loaded.document.pages[0]!.children;
    expect(ids).toEqual(e41.document.pages[0]!.children);
    expect(ids).toHaveLength(E41_CARDS.count);
    // The inner shadow is the editor's default (V-36 section 6).
    expect(V36_GLASS.innerShadow).toEqual(DEFAULT_INNER_SHADOW);
    ids.forEach((id, i) => {
      const card = loaded.document.nodes[id]!;
      const before = e41.document.nodes[id]!;
      expect(card.type).toBe('group');
      expect(card.parent).toBe('cards-page');
      expect([card.opacity, card.blendMode]).toEqual([1, 'passThrough']);
      const bg = loaded.document.nodes[`${id}-bg`] as Extract<NodeV8, { type: 'rectangle' }>;
      if (glass(i)) {
        expect(card.effects).toEqual([
          ...before.effects,
          V36_GLASS.innerShadow,
          { kind: 'backgroundBlur', visible: true, radius: 20 },
        ]);
        expect(bg.fills).toEqual([
          { paint: { r: 1, g: 1, b: 1, a: 0.3 }, visible: true, opacity: 1, blendMode: 'normal' },
        ]);
      } else {
        // The other cards are e41-cards' own, node for node.
        expect(card).toEqual(before);
        expect(bg).toEqual(e41.document.nodes[`${id}-bg`]);
      }
      for (const child of ['header', 'avatar'])
        expect(loaded.document.nodes[`${id}-${child}`]).toEqual(
          e41.document.nodes[`${id}-${child}`],
        );
    });
    expect(ids.filter((_, i) => glass(i))).toHaveLength(V36_GLASS.glassCards);
    expect(JSON.stringify(generateV36GlassDocument())).toBe(
      JSON.stringify(generateV36GlassDocument()),
    );
  });

  it("projects 10 top-level background-blur roots under 'v1' and leaves them out under true", () => {
    const roots = (effects: boolean | 'v1') =>
      [...project(effects).nodes.values()].filter((node) =>
        node.effects?.some((effect) => effect.kind === 'backgroundBlur'),
      );
    const on = roots('v1');
    expect(on.map((node) => node.id)).toEqual(
      Array.from({ length: 10 }, (_, k) => `card-${String(5 * k).padStart(2, '0')}`),
    );
    for (const node of on) {
      // A root on the page: its composite is in the main pass (V-36 section 5.3).
      expect(node.parentId).toBeNull();
      expect(node.kind).toBe('container');
      expect(node.opacity).toBe(1);
      expect(node.effects!.slice(-2)).toEqual([
        expect.objectContaining({ kind: 'innerShadow', sigma: 2, offsetY: 4 }),
        { kind: 'backgroundBlur', sigma: 10 },
      ]);
    }
    expect(roots(true)).toHaveLength(0);
    // Every card stays an effect root.
    const effectRoots = [...project('v1').nodes.values()].filter(
      (node) => (node.effects?.length ?? 0) > 0,
    );
    expect(effectRoots).toHaveLength(E41_CARDS.count);
  });

  it('shows no nested note on any glass card (the panel rule, section 5.3)', () => {
    const { document } = loadScenarioDocument('v36-glass');
    for (let i = 0; i < E41_CARDS.count; i += V36_GLASS.glassEvery) {
      const node = document.nodes[`card-${String(i).padStart(2, '0')}`]!;
      const rows = effectRows([node]);
      const row = rows.find((entry) => entry.kind === 'backgroundBlur')!;
      expect(row).toBeDefined();
      expect(backgroundBlurNested(document, [node], row)).toBe(false);
    }
  });

  it('asks a main-pass backdrop for every glass card at the fitted camera', () => {
    const loaded = loadScenarioDocument('v36-glass');
    const projection = project('v1');
    const camera = e26Configuration(V36_SCENARIOS[0]!, 1, 5, loaded).camera;
    const mirror = new RetainedSceneMirror(undefined, {
      pathNodes: 'unsupported',
      clips: 'supported',
      groupOpacity: 'supported',
      effects: 'v1',
      blend: 'v0',
    });
    mirror.setCamera(camera);
    const result = mirror.replaceSnapshot({
      identity: { documentId: 'v36-glass', pageId: loaded.pageId },
      revision: 1,
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
    });
    expect(result.status).toBe('applied');
    const packet = new PrimitiveSceneSource(mirror).prepare({
      generation: 1,
      surfaceRevision: 1,
      width: E26_VIEWPORT.width,
      height: E26_VIEWPORT.height,
      devicePixelRatio: 1,
      sampleCount: 1,
      targetFormat: 'bgra8unorm',
      backdropSnapshots: true,
      blendLayers: true,
    }) as PrimitivePacket;
    const layers = packet.layers!.layers;
    const withBackdrop = layers.filter((layer) => layer.backdrop !== undefined);
    expect(withBackdrop.map((layer) => layer.nodeId).sort()).toEqual(
      Array.from({ length: 10 }, (_, k) => `card-${String(5 * k).padStart(2, '0')}`),
    );
    const sigmaPx = 10 * camera.zoom;
    for (const layer of withBackdrop) {
      expect(layer.parent).toBe(-1);
      expect(layer.blend).toBeUndefined();
      expect(layer.backdrop).toEqual({ margin: backdropMargin(sigmaPx) });
    }
    // No layer is a blend root: the frame's splits are the background blurs' alone.
    expect(layers.filter((layer) => layer.blend !== undefined)).toHaveLength(0);
  });

  it('keeps every card in view along the pan and zoom path and the dragged card in the drag', () => {
    const loaded = loadScenarioDocument('v36-glass');
    const [view, drag] = V36_SCENARIOS as [(typeof V36_SCENARIOS)[0], (typeof V36_SCENARIOS)[0]];
    expect(view).toMatchObject({
      id: 'v36-glass-view/v1',
      document: 'v36-glass',
      camera: 'fitted',
      interaction: 'pan-zoom',
      frameCeilingMs: 16.7,
    });
    expect(drag).toMatchObject({
      id: 'v36-glass-drag/v1',
      document: 'v36-glass',
      camera: 'fitted',
      interaction: 'edit-drag',
      frameCeilingMs: 16.7,
    });
    const configuration = e26Configuration(view, 2, 5, loaded);
    expect(configuration.schemaVersion).toBe(8);
    expect(configuration.drawnLeaves).toBe(150);
    expect(loaded.pageId).toBe('cards-page');
    // The same fitted camera as e41-cards.
    const e41 = loadScenarioDocument('e41-cards');
    expect(configuration.camera).toEqual(e26Configuration(V36_SCENARIOS[0]!, 2, 5, e41).camera);
    const camera = configuration.camera;
    for (let t = 0; t < E26_DRIVERS.thetaPeriodMs; t += 10) {
      const seen = visibility(loaded.bounds, panZoomCamera(camera, t), 2);
      expect(seen.inside, `t ${t}`).toBe(seen.leaves);
    }
    // The dragged card (not a glass card) is pressed at its background, a leaf of its own.
    const { pressed, ids } = e41CardsMoveSelection();
    expect(ids).toEqual(['card-22']);
    const box = nodeDrawBounds(loaded.bounds, pressed)!;
    expect(box).toEqual(e41.bounds.get(pressed));
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
