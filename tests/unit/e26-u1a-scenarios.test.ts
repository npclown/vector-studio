// E26-U1a (E26 contract, sections 3.1 to 3.3, E26-A01): the scenario documents generate
// deterministically, the fitted camera keeps every leaf visible along the whole pan and zoom
// path and the edit drag, the typical view shows 900 to 1,100 leaves with the move selection
// inside it, and the configuration hash is canonical and stable.
import { parseDocument, type DocumentV5 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import {
  canonicalJson,
  configurationHash,
  contentBounds,
  E26_SCENARIOS,
  E26_STRESS_NODE_COUNT,
  E26_TYPICAL_VISIBLE,
  E26_VIEWPORT,
  E26_WINDOW_MS,
  editDragOffset,
  fittedCamera,
  generateStressDocument,
  leafWorldBounds,
  panZoomCamera,
  typicalCamera,
  visibility,
  worldViewport,
  type E26Camera,
} from '../e26/scenarios.js';
import { generateM1A13Document, m1A13MoveSelection } from '../m1-a13/document.js';

function load(json: unknown): DocumentV5 {
  const parsed = parseDocument(JSON.stringify(json));
  if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
  return parsed.document;
}

const mixedJson = generateM1A13Document();
const mixed = load(mixedJson);
const mixedScene = projectPage(mixed, 'page-1', () => null);
const mixedBounds = leafWorldBounds(mixedScene.nodes);
const stressJson = generateStressDocument();
const stress = load(stressJson);
const stressScene = projectPage(stress, 'stress-page', () => null);
const stressBounds = leafWorldBounds(stressScene.nodes);

/** Every leaf with bounds lies inside the camera's viewport. */
function allInside(bounds: typeof mixedBounds, camera: E26Camera) {
  const { inside, leaves } = visibility(bounds, camera);
  return inside === leaves;
}

describe('E26-U1a scenarios', () => {
  it('lists the five v1 scenarios of section 3.1 with their targets', () => {
    expect(E26_SCENARIOS.map((scenario) => [scenario.id, scenario.frameCeilingMs])).toEqual([
      ['e26-mixed-view-edit-10k/v1', 16.7],
      ['e26-mixed-all-edit-10k/v1', 33.3],
      ['e26-mixed-all-pan-10k/v1', 33.3],
      ['e26-simple-stress-10k/v1', 33.3],
      ['e26-pointer-busy-10k/v1', null],
    ]);
    const busy = E26_SCENARIOS[4]!;
    expect(busy).toMatchObject({
      latencyBoundMs: 50,
      renderMode: 'on-demand',
      persist: true,
      reject: { mode: 'once', armedAtMs: 1_000, target: 'moved-leaf' },
      setFillBeforeDownMs: 100,
    });
  });

  it('generates both documents deterministically', () => {
    expect(canonicalJson(generateStressDocument())).toBe(canonicalJson(stressJson));
    expect(canonicalJson(generateM1A13Document())).toBe(canonicalJson(mixedJson));
    expect(Object.keys(stress.nodes)).toHaveLength(E26_STRESS_NODE_COUNT);
    expect(stressScene.nodes.size).toBe(E26_STRESS_NODE_COUNT);
    expect(mixedScene.nodes.size).toBe(10_634);
  });

  it('keeps P1 sizes and opacity and has no stroke in the stress document', () => {
    for (const [index, id] of stress.pages[0]!.children.entries()) {
      const node = stress.nodes[id]!;
      expect(node.opacity).toBe(0.5 + 0.25 * (index % 3));
      expect('stroke' in node ? node.stroke : null).toBeNull();
      const size = [node.frame.width, node.frame.height];
      expect(size).toEqual(index % 4 === 1 ? [3, 3] : index % 4 === 3 ? [3.5, 1] : [3, 2]);
    }
  });

  for (const [name, bounds] of [
    ['mixed', mixedBounds],
    ['stress', stressBounds],
  ] as const) {
    it(`fits every ${name} leaf at F and along the whole pan and zoom path`, () => {
      const fitted = fittedCamera(contentBounds(bounds));
      expect(allInside(bounds, fitted)).toBe(true);
      // One sample per ms over a whole period covers every theta to 2·pi/10,000.
      for (let t = 0; t < 10_000; t += 1) {
        expect(allInside(bounds, panZoomCamera(fitted, t))).toBe(true);
      }
    });
  }

  it('keeps the moved selection inside F and the typical view through the whole edit drag', () => {
    const { ids } = m1A13MoveSelection(mixedJson);
    for (const camera of [fittedCamera(contentBounds(mixedBounds)), typicalCamera(mixedBounds)]) {
      const view = worldViewport(camera);
      for (let t = 0; t < 10_000; t += 10) {
        const offset = editDragOffset(t);
        expect(Math.abs(offset.x)).toBeLessThanOrEqual(40);
        expect(offset.y).toBeLessThanOrEqual(0);
        expect(offset.y).toBeGreaterThanOrEqual(-60);
        for (const id of ids) {
          const box = mixedBounds.get(id)!;
          const dx = offset.x / camera.zoom;
          const dy = offset.y / camera.zoom;
          expect(box.minX + dx).toBeGreaterThanOrEqual(view.minX);
          expect(box.maxX + dx).toBeLessThanOrEqual(view.maxX);
          expect(box.minY + dy).toBeGreaterThanOrEqual(view.minY);
          expect(box.maxY + dy).toBeLessThanOrEqual(view.maxY);
        }
      }
    }
  });

  it('chooses a typical view with 900 to 1,100 visible leaves', () => {
    const camera = typicalCamera(mixedBounds);
    const { visible, leaves } = visibility(mixedBounds, camera);
    expect(visible).toBeGreaterThanOrEqual(E26_TYPICAL_VISIBLE.min);
    expect(visible).toBeLessThanOrEqual(E26_TYPICAL_VISIBLE.max);
    expect(visible).toBeLessThan(leaves);
  });

  it('hashes the canonical configuration, stable across runs and sensitive to every field', () => {
    const configuration = {
      scenario: E26_SCENARIOS[0]!,
      schemaVersion: mixed.schemaVersion,
      viewport: E26_VIEWPORT,
      devicePixelRatio: 1,
      camera: typicalCamera(mixedBounds),
      sceneNodes: mixedScene.nodes.size,
      leaves: visibility(mixedBounds, typicalCamera(mixedBounds)).leaves,
      window: E26_WINDOW_MS,
      repetitions: 5,
    };
    const hash = configurationHash(configuration);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      configurationHash(JSON.parse(JSON.stringify(configuration)) as typeof configuration),
    ).toBe(hash);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(configurationHash({ ...configuration, devicePixelRatio: 2 })).not.toBe(hash);
    expect(
      configurationHash({ ...configuration, scenario: { ...configuration.scenario, seed: 1 } }),
    ).not.toBe(hash);
  });
});
