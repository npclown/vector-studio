// E26-U1a (E26 contract, sections 3.1 to 3.3, E26-A01): the scenario documents generate
// deterministically and match their pinned digests, the stress document follows P1, the fitted
// camera keeps every drawn leaf inside the viewport along the whole pan and zoom path and the
// edit drag, the drag leaves its frame's clip (recorded, section 3.3), the typical view shows 900
// to 1,100 drawn leaves at DPR 1 and 2 with the selection inside it, and the configuration hash
// is canonical and covers every field.
import { describe, expect, it } from 'vitest';
import { frameContentId } from '../../packages/editor-core/src/projector.js';
import { transformSceneBounds } from '../../packages/renderer-core/src/scene-numeric.js';
import {
  canonicalJson,
  configurationHash,
  contains,
  contentBounds,
  e26Configuration,
  E26_SCENARIOS,
  E26_STRESS,
  E26_TYPICAL_VISIBLE,
  editDragOffset,
  E26_ISOLATION,
  fittedCamera,
  isolationBoundsMs,
  isolationTargets,
  generateStressDocument,
  loadScenarioDocument,
  p1Q,
  panZoomCamera,
  sha256,
  stressCenter,
  typicalCamera,
  visibility,
  worldTransforms,
  worldViewport,
  type E26Camera,
} from '../e26/scenarios.js';
import { generateM1A13Document, m1A13MoveSelection } from '../m1-a13/document.js';

const mixed = loadScenarioDocument('m1-a13');
const stress = loadScenarioDocument('stress');

/** Pinned digests of the canonical generated documents (U1a); a change is a new version. */
const MIXED_SHA256 = 'd8658b14694ca1e6bbcff734e35575222511df96281720068fa4efe2cb9ef974';
const STRESS_SHA256 = 'dc5cf1a75b00e460fa638ec2197024287671beced964522a03d093ded541fae1';

/** The typical view (U1a amendment), pinned. */
const TYPICAL_ZOOM = 0.44287156211454926;
const TYPICAL_VISIBLE = 995;
const TYPICAL_VISIBLE_DPR2 = 987;
/** The configuration hash of `e26-mixed-view-edit-10k/v1` at DPR 1, five repetitions. */
const VIEW_EDIT_HASH = 'fbacd41cb86ccb66be4dbae73c827cd57934963b741761db21d7e317d777d4a6';

function allInside(bounds: typeof mixed.bounds, camera: E26Camera) {
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
    expect(E26_SCENARIOS[4]).toMatchObject({
      latencyBoundMs: 50,
      renderMode: 'on-demand',
      persist: true,
      reject: { mode: 'once', armedAtMs: 1_000, target: 'moved-leaf' },
      setFillBeforeDownMs: 100,
    });
  });

  it('generates both documents deterministically, matching their pinned digests', () => {
    expect(sha256(canonicalJson(generateM1A13Document()))).toBe(MIXED_SHA256);
    expect(sha256(canonicalJson(generateStressDocument()))).toBe(STRESS_SHA256);
    expect(Object.keys(stress.document.nodes)).toHaveLength(E26_STRESS.count);
    expect(stress.projection.nodes.size).toBe(E26_STRESS.count);
    expect(mixed.projection.nodes.size).toBe(10_634);
  });

  it('follows P1 for centres, sizes, opacity and fill (P1 measurement contract)', () => {
    // Hand-computed: u(0) = (1664525 · 0x50310001 + 1013904223) mod 2^32.
    const u0 = (Math.imul(1664525, 0x50310001) + 1013904223) >>> 0;
    expect(p1Q(0, 0)).toBe((u0 & 255) / 255);
    expect(p1Q(0, 3)).toBe((u0 >>> 24) / 255);
    expect(stressCenter(0)).toEqual({
      x: 180 + 2 * ((u0 & 255) / 255) - 1,
      y: 160 + 2 * (((u0 >>> 8) & 255) / 255) - 1,
    });
    const last = stressCenter(9_999);
    expect(Math.abs(last.x - 1080)).toBeLessThanOrEqual(1);
    expect(Math.abs(last.y - 560)).toBeLessThanOrEqual(1);
    for (const [index, id] of stress.document.pages[0]!.children.entries()) {
      const node = stress.document.nodes[id]!;
      const { x, y } = stressCenter(index);
      // P1's enclosure (its "Reproduce workload arithmetic" script).
      expect(x - 1.75 >= 40 && x + 1.75 <= 1280 / 1.1).toBe(true);
      expect(y - 1.75 >= 20 && y + 1.75 <= 720 / 1.1).toBe(true);
      expect(node.frame.x + node.frame.width / 2).toBeCloseTo(x, 9);
      expect(node.frame.y + node.frame.height / 2).toBeCloseTo(y, 9);
      expect(node.opacity).toBe(0.5 + 0.25 * (index % 3));
      expect('stroke' in node ? node.stroke : null).toBeNull();
      expect('fill' in node ? node.fill : null).toEqual({
        r: 0.2 + 0.6 * p1Q(index, 0),
        g: 0.2 + 0.6 * p1Q(index, 1),
        b: 0.2 + 0.6 * p1Q(index, 2),
        a: 0.45 + 0.4 * p1Q(index, 3),
      });
      const size = [node.frame.width, node.frame.height];
      expect(size).toEqual(index % 4 === 1 ? [3, 3] : index % 4 === 3 ? [3.5, 1] : [3, 2]);
    }
  });

  it('counts only drawn leaves: hidden ancestry and mask sources are left out', () => {
    const leaves = [...mixed.projection.nodes.values()].filter(
      (node) => node.kind === 'primitive' || node.kind === 'path' || node.kind === 'text',
    );
    expect(leaves).toHaveLength(7_324);
    expect(mixed.bounds.size).toBe(6_494);
    expect(stress.bounds.size).toBe(E26_STRESS.count);
  });

  for (const [name, loaded] of [
    ['mixed', mixed],
    ['stress', stress],
  ] as const) {
    it(`fits every drawn ${name} leaf at F and along the whole pan and zoom path`, () => {
      const fitted = fittedCamera(contentBounds(loaded.bounds));
      expect(allInside(loaded.bounds, fitted)).toBe(true);
      // One sample per ms over a whole period covers every theta to 2·pi/10,000.
      for (let t = 0; t < 10_000; t += 1) {
        expect(allInside(loaded.bounds, panZoomCamera(fitted, t))).toBe(true);
      }
    });
  }

  it('keeps the moved selection in the viewport through the edit drag, outside its clip at times', () => {
    const { ids } = m1A13MoveSelection(mixed.generated as ReturnType<typeof generateM1A13Document>);
    const frameId = (mixed.generated as ReturnType<typeof generateM1A13Document>).pages[0]!
      .children[0]!;
    const content = mixed.projection.nodes.get(frameContentId(frameId))!;
    if (content.kind !== 'container' || content.clip?.kind !== 'rect') throw new Error('no clip');
    const clip = transformSceneBounds(
      {
        minX: content.clip.x,
        minY: content.clip.y,
        maxX: content.clip.x + content.clip.width,
        maxY: content.clip.y + content.clip.height,
      },
      worldTransforms(mixed.projection.nodes).get(content.id)!,
    )!;
    for (const camera of [fittedCamera(contentBounds(mixed.bounds)), typicalCamera(mixed.bounds)]) {
      const view = worldViewport(camera);
      let leftClip = false;
      for (let t = 0; t < 10_000; t += 10) {
        const offset = editDragOffset(t);
        expect(Math.abs(offset.x)).toBeLessThanOrEqual(40);
        expect(offset.y).toBeLessThanOrEqual(0);
        expect(offset.y).toBeGreaterThanOrEqual(-60);
        for (const id of ids) {
          const box = mixed.bounds.get(id)!;
          const dx = offset.x / camera.zoom;
          const dy = offset.y / camera.zoom;
          const moved = {
            minX: box.minX + dx,
            minY: box.minY + dy,
            maxX: box.maxX + dx,
            maxY: box.maxY + dy,
          };
          expect(contains(view, moved)).toBe(true);
          if (moved.maxY < clip.minY) leftClip = true;
        }
      }
      // Section 3.3: the drag moves the selection out of its frame's clip, so the renderer's
      // clip cull drops it for part of each period; "culls nothing" is about the viewport.
      expect(leftClip).toBe(true);
    }
  });

  it('chooses a typical view with 900 to 1,100 drawn leaves visible at DPR 1 and 2', () => {
    const camera = typicalCamera(mixed.bounds);
    expect(camera.zoom).toBeCloseTo(TYPICAL_ZOOM, 6);
    for (const dpr of [1, 2]) {
      const { visible, leaves } = visibility(mixed.bounds, camera, dpr);
      expect(visible).toBeGreaterThanOrEqual(E26_TYPICAL_VISIBLE.min);
      expect(visible).toBeLessThanOrEqual(E26_TYPICAL_VISIBLE.max);
      expect(visible).toBeLessThan(leaves);
    }
    expect(visibility(mixed.bounds, camera).visible).toBe(TYPICAL_VISIBLE);
    expect(visibility(mixed.bounds, camera, 2).visible).toBe(TYPICAL_VISIBLE_DPR2);
  });

  it('hashes the canonical configuration, stable across runs and sensitive to every field', () => {
    const configuration = e26Configuration(E26_SCENARIOS[0]!, 1, 5, mixed);
    expect(configuration.drawnLeaves).toBe(6_494);
    const hash = configurationHash(configuration);
    expect(hash).toBe(VIEW_EDIT_HASH);
    expect(
      configurationHash(JSON.parse(JSON.stringify(configuration)) as typeof configuration),
    ).toBe(hash);
    expect(e26Configuration(E26_SCENARIOS[0]!, 1, 5)).toEqual(configuration);
    for (const key of Object.keys(configuration) as (keyof typeof configuration)[]) {
      const changed = { ...configuration, [key]: { changed: key } };
      expect(configurationHash(changed as typeof configuration), key).not.toBe(hash);
    }
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });
});

describe('E26-U6b A06 isolation targets and bounds', () => {
  it('picks the middle drawn leaf and 16 distinct leaves spread over the M1-A13 page', () => {
    const loaded = loadScenarioDocument('m1-a13');
    const leaves = [...loaded.bounds].filter(([, box]) => box !== null).map(([id]) => id);
    const targets = isolationTargets(loaded);
    expect(targets.one).toBe(leaves[Math.floor(leaves.length / 2)]);
    expect(targets.sixteen).toHaveLength(E26_ISOLATION.scattered);
    expect(new Set(targets.sixteen).size).toBe(16);
    const ranks = targets.sixteen.map((id) => leaves.indexOf(id));
    expect(ranks.every((rank, i) => i === 0 || rank > ranks[i - 1]!)).toBe(true);
    // Every sixteenth of the leaf order holds one target.
    ranks.forEach((rank, k) => {
      expect(rank).toBeGreaterThanOrEqual((k * leaves.length) / 16);
      expect(rank).toBeLessThan(((k + 1) * leaves.length) / 16);
    });
    // Deterministic: the same document gives the same targets.
    expect(isolationTargets(loadScenarioDocument('m1-a13'))).toEqual(targets);
  });

  it('refuses a page with fewer than 16 drawn leaves', () => {
    const loaded = loadScenarioDocument('m1-a13');
    const bounds = new Map([...loaded.bounds].filter(([, box]) => box !== null).slice(0, 15));
    expect(() => isolationTargets({ ...loaded, bounds })).toThrow('15 drawn leaves');
  });

  it('applies min(3R + 50, 500) and min(6R + 100, 1000)', () => {
    expect(isolationBoundsMs(0)).toEqual({ one: 50, sixteen: 100 });
    expect(isolationBoundsMs(40)).toEqual({ one: 170, sixteen: 340 });
    expect(isolationBoundsMs(150)).toEqual({ one: 500, sixteen: 1000 });
    expect(isolationBoundsMs(149)).toEqual({ one: 497, sixteen: 994 });
  });
});
