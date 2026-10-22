import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RenderNodeSnapshot, RenderSceneSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  VIZ_V3_CHURN,
  VIZ_V3_CHURN_PROBES,
  VIZ_V3_JOINT_BAND_PROBE,
  VIZ_V3_ORDER_PROBES,
  VIZ_V3_ORDER_STATES,
  VIZ_V3_ORDER_ZONE_IDS,
  VIZ_V3_SURFACE,
  VIZ_V3_SWAPPED_PROBES,
  buildVizV3Script,
  churnStepId,
  stateScene,
  type VizV3Probe,
} from '../../apps/playground/src/viz-v3-integration-scene.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  EPSILON,
  colorChangeWithin,
  flattenCubic,
  nodeBounds,
  oracleColor,
  paintOrder,
  segmentDistance,
  separation,
  to8,
} from '../support/viz-v3-oracle.js';

// Visualization track V-3 (docs/plans/viz-v3-a07-integration-contract.md), criterion VZ3-A2:
// the scene module is valid and deterministic, every overlap of section 3.2 holds in S0 by the
// oracle's membership, the churn zone overlaps no order-zone layer, the slot counts of section
// 3.4 are computed from the scene data and checked, the oracle's flattening meets epsilon, the
// probe rule holds, and the scene module imports no DOM, GPU or WASM code. Functional evidence
// only: precision is UNVERIFIED against the 0.25 physical-pixel target.

const supported = {
  pathNodes: 'supported',
  pathFills: 'supported',
  pathStrokes: 'supported',
} as const;
const script = buildVizV3Script();
const PROBE_TOLERANCE = 12;
/** The probe rule's radius: 2 CSS px plus the flattening epsilon. */
const PROBE_MARGIN = 2 + EPSILON;
const probe = (name: string): VizV3Probe => VIZ_V3_ORDER_PROBES.find((p) => p.name === name)!;
const at = (scene: RenderSceneSnapshot, p: VizV3Probe) => oracleColor(scene, p.x, p.y);

describe('V-3 scene module (VZ3-A2)', () => {
  it('is deterministic: two builds are identical', () => {
    expect(JSON.stringify(buildVizV3Script())).toBe(JSON.stringify(script));
  });

  it('applies S0 and every state, recovery edit and churn step in order with consecutive revisions', () => {
    const mirror = new RetainedSceneMirror(undefined, supported);
    expect(mirror.replaceSnapshot(script.initial).status).toBe('applied');
    let revision = script.initial.revision;
    expect(revision).toBe(1);
    for (const step of script.steps) {
      expect(step.changes.baseRevision, step.id).toBe(revision);
      expect(step.changes.revision, step.id).toBe(revision + 1);
      const result = mirror.applyChanges(step.changes);
      expect(result, step.id).toMatchObject({ status: 'applied' });
      revision += 1;
      expect(step.scene.revision).toBe(revision);
    }
    // 5 order states, 4 recovery edits, 3 change sets per churn cycle.
    expect(script.steps).toHaveLength(5 + 4 + 3 * VIZ_V3_CHURN.cycles);
    expect(script.steps.map((step) => step.id).slice(0, 9)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      'r2-x',
      'r2-x-inverse',
      'r2-x-window',
      'r2-restore',
    ]);
    mirror.dispose();
  });

  it("every step's scene is a valid snapshot of the same content (a fresh mirror accepts it)", () => {
    for (const scene of [script.initial, ...script.steps.map((step) => step.scene)]) {
      const mirror = new RetainedSceneMirror(undefined, supported);
      expect(mirror.replaceSnapshot(scene).status).toBe('applied');
      mirror.dispose();
    }
    // R2 restores S5's content; the churn leaves the order zone as in S5.
    const strip = (scene: RenderSceneSnapshot) =>
      JSON.stringify({
        nodes: [...scene.nodes]
          .filter((node) => !node.id.startsWith('ch-'))
          .sort((a, b) => a.id.localeCompare(b.id)),
        root: scene.rootOrder.filter((id) => !id.startsWith('ch-')),
      });
    const s5 = strip(stateScene(script, 's5'));
    expect(strip(script.steps.find((s) => s.id === 'r2-x-inverse')!.scene)).toBe(s5);
    expect(strip(script.steps.find((s) => s.id === 'r2-restore')!.scene)).toBe(s5);
    expect(strip(script.steps.at(-1)!.scene)).toBe(s5);
    expect(JSON.stringify(script.steps.find((s) => s.id === 'r2-x-window')!.scene.nodes)).toBe(
      JSON.stringify(stateScene(script, 'e').nodes),
    );
  });

  it('holds every overlap of section 3.2 in S0 by the oracle membership', () => {
    const s0 = script.initial;
    const expectations: Array<[string, readonly string[], string]> = [
      ['square fill only', ['bg', 'p-square'], 'p-square'],
      ['band over square fill', ['bg', 'p-square', 'r-band'], 'r-band'],
      ['band over square stroke', ['bg', 'p-square', 'r-band'], 'r-band'],
      ['square stroke (top band)', ['bg', 'p-square'], 'p-square'],
      ['circle over band', ['bg', 'r-band', 'p-circle'], 'p-circle'],
      ['circle above band', ['bg', 'p-circle'], 'p-circle'],
      ['star centre over dot', ['bg', 'e-dot', 'p-star'], 'p-star'],
      ['dot only', ['bg', 'e-dot'], 'e-dot'],
      ['line in right arm', ['bg', 'l-line', 'p-star'], 'p-star'],
      ['line in left arm', ['bg', 'l-line', 'p-star'], 'p-star'],
      ['line only', ['bg', 'l-line'], 'l-line'],
      ['star top arm', ['bg', 'p-star'], 'p-star'],
      ['half over under', ['bg', 'r-under', 'p-half'], 'p-half'],
      ['half rectangle over solid', ['bg', 'p-solid', 'r-half'], 'r-half'],
      ['joint fill only', ['bg', 'r-jbase', 'p-joint'], 'p-joint'],
      ['joint stroke over fill', ['bg', 'r-jbase', 'p-joint'], 'p-joint'],
      ['joint stroke only', ['bg', 'r-jbase', 'p-joint'], 'p-joint'],
      ['joint base only', ['bg', 'r-jbase'], 'r-jbase'],
      ['order background', ['bg'], 'bg'],
    ];
    for (const [name, covering, top] of expectations) {
      const color = at(s0, probe(name));
      expect(color.covering, name).toEqual(covering);
      expect(color.top, name).toBe(top);
    }
    // The paint order of S0 interleaves paths and primitives: path, rectangle, path, line,
    // container (ellipse, path), and the half-opacity and joint layers.
    expect(paintOrder(s0).map((layer) => layer.node.id)).toEqual([
      'bg',
      'p-square',
      'r-band',
      'p-circle',
      'l-line',
      'e-dot',
      'p-star',
      'r-under',
      'p-half',
      'p-solid',
      'r-half',
      'r-jbase',
      'p-joint',
      'ch-persist',
    ]);
    // p-joint carries both paints at opacity 0.5 (the ST-U7 joint draw).
    const joint = s0.nodes.find((node) => node.id === 'p-joint')!;
    expect(joint).toMatchObject({ opacity: 0.5, style: { fill: {}, stroke: { width: 10 } } });
  });

  it('keeps the churn zone apart from every order-zone layer (bg is the shared backdrop)', () => {
    const scenes = [script.initial, ...script.steps.map((step) => step.scene)];
    for (const scene of scenes) {
      const layers = paintOrder(scene);
      const bounds = layers.map((layer) => ({
        id: layer.node.id,
        box: nodeBounds(layer.node, layer.world)!,
      }));
      const order = bounds.filter(
        (entry) => VIZ_V3_ORDER_ZONE_IDS.includes(entry.id) && entry.id !== 'bg',
      );
      const churn = bounds.filter((entry) => entry.id.startsWith('ch-'));
      for (const entry of order) expect(entry.box.maxX, entry.id).toBeLessThan(480);
      for (const entry of churn) {
        expect(entry.box.minX, entry.id).toBeGreaterThanOrEqual(480);
        expect(entry.box.maxX, entry.id).toBeLessThanOrEqual(VIZ_V3_SURFACE.width);
        expect(entry.box.maxY, entry.id).toBeLessThanOrEqual(VIZ_V3_SURFACE.height);
      }
    }
  });

  it('computes and checks the slot counts of section 3.4', () => {
    const primitives = (scene: RenderSceneSnapshot) =>
      scene.nodes.filter((node) => node.kind === 'primitive').length;
    const pathSlots = (scene: RenderSceneSnapshot) =>
      scene.nodes.reduce(
        (sum, node) =>
          node.kind !== 'path'
            ? sum
            : sum +
              (node.style.fill === null ? 0 : 1) +
              (node.style.stroke !== null && node.style.stroke.width > 0 ? 1 : 0),
        0,
      );
    const orderSlots = (scene: RenderSceneSnapshot) =>
      paintOrder(scene).filter((layer) => layer.node.kind === 'primitive').length;
    const measures = { primitives, pathSlots, orderSlots } as const;
    const record: Record<string, unknown> = {};
    for (const [name, measure] of Object.entries(measures)) {
      const peaks = new Set<number>();
      const ends: Record<'odd' | 'even', Set<number>> = { odd: new Set(), even: new Set() };
      for (let c = VIZ_V3_CHURN.warmup + 1; c <= VIZ_V3_CHURN.cycles; c += 1) {
        const values = (['add', 'replace', 'remove'] as const).map((step) =>
          measure(script.steps.find((s) => s.id === churnStepId(c, step))!.scene),
        );
        peaks.add(Math.max(...values));
        ends[c % 2 === 1 ? 'odd' : 'even'].add(values[2]!);
      }
      expect(peaks.size, name).toBe(1);
      const peak = [...peaks][0]!;
      const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(peak)));
      record[name] = {
        peak,
        endOdd: [...ends.odd],
        endEven: [...ends.even],
        capacity,
        headroomOdd: capacity - [...ends.odd][0]!,
        headroomEven: capacity - [...ends.even][0]!,
      };
    }
    // Section 3.4's expected values. Path slots: 12 at the peak, because p-joint's overlay
    // variant shares the fill slot's instance record (ST-U7 addendum, section 4.5: words 12 to
    // 15 of the fill record) and holds no record of its own.
    expect(record).toEqual({
      primitives: {
        peak: 9,
        endOdd: [8],
        endEven: [8],
        capacity: 16,
        headroomOdd: 8,
        headroomEven: 8,
      },
      pathSlots: {
        peak: 12,
        endOdd: [10],
        endEven: [11],
        capacity: 16,
        headroomOdd: 6,
        headroomEven: 5,
      },
      orderSlots: {
        peak: 9,
        endOdd: [8],
        endEven: [8],
        capacity: 16,
        headroomOdd: 8,
        headroomEven: 8,
      },
    });
  });

  it("the oracle's flattening meets epsilon on every cubic of the scene", () => {
    let cubics = 0;
    const seen = new Set<string>();
    for (const scene of [script.initial, ...script.steps.map((step) => step.scene)]) {
      for (const node of scene.nodes) {
        if (node.kind !== 'path') continue;
        const key = JSON.stringify(node.geometry);
        if (seen.has(key)) continue;
        seen.add(key);
        const { verbs, points } = node.geometry;
        let cursor = 0;
        let last: [number, number] = [0, 0];
        for (const verb of verbs) {
          if (verb === 'move' || verb === 'line') {
            last = [points[cursor]!, points[cursor + 1]!];
            cursor += 2;
          } else if (verb === 'cubic') {
            const p1: [number, number] = [points[cursor]!, points[cursor + 1]!];
            const p2: [number, number] = [points[cursor + 2]!, points[cursor + 3]!];
            const p3: [number, number] = [points[cursor + 4]!, points[cursor + 5]!];
            cursor += 6;
            cubics += 1;
            const leaves = flattenCubic(last, p1, p2, p3);
            expect(leaves.length).toBeGreaterThan(1);
            for (const leaf of leaves) {
              expect(segmentDistance(leaf.p1, leaf.p0, leaf.p3)).toBeLessThanOrEqual(EPSILON);
              expect(segmentDistance(leaf.p2, leaf.p0, leaf.p3)).toBeLessThanOrEqual(EPSILON);
            }
            // Dense samples of the true curve lie within epsilon of the polyline.
            const polyline = [leaves[0]!.p0, ...leaves.map((leaf) => leaf.p3)];
            for (let sample = 0; sample <= 200; sample += 1) {
              const t = sample / 200;
              const u = 1 - t;
              const point: [number, number] = [
                u * u * u * last[0] +
                  3 * u * u * t * p1[0] +
                  3 * u * t * t * p2[0] +
                  t * t * t * p3[0],
                u * u * u * last[1] +
                  3 * u * u * t * p1[1] +
                  3 * u * t * t * p2[1] +
                  t * t * t * p3[1],
              ];
              let nearest = Infinity;
              for (let index = 0; index + 1 < polyline.length; index += 1)
                nearest = Math.min(
                  nearest,
                  segmentDistance(point, polyline[index]!, polyline[index + 1]!),
                );
              expect(nearest).toBeLessThanOrEqual(EPSILON);
            }
            last = p3;
          }
        }
      }
    }
    // The circle path: four cubics.
    expect(cubics).toBe(4);
  });

  it('places every probe by the probe rule (2 px + epsilon from every color-changing boundary)', () => {
    // The sampler sees a boundary inside the disc: p-square's fill and stroke meet at x = 115 in
    // S3, and p-joint's fill and stroke at x = 125 in S0 (its single-application stroke-over-fill
    // and stroke-only bands share one color, so x = 130 is no color boundary there).
    expect(colorChangeWithin(stateScene(script, 's3'), 116.5, 100, PROBE_MARGIN)).not.toBeNull();
    expect(colorChangeWithin(script.initial, 126.5, 400, PROBE_MARGIN)).not.toBeNull();
    expect(colorChangeWithin(script.initial, 127.5, 400, PROBE_MARGIN)).toBeNull();
    const states = [...VIZ_V3_ORDER_STATES, 'e'] as const;
    for (const state of states) {
      const scene = stateScene(script, state);
      for (const p of VIZ_V3_ORDER_PROBES) {
        const change = colorChangeWithin(scene, p.x, p.y, PROBE_MARGIN);
        expect(change, `${state}: ${p.name}`).toBeNull();
      }
    }
    // Churn probes are compared at end-of-cycle samples of both parities.
    for (const c of [1, 2, 31, 32, 63, 64]) {
      const scene = script.steps.find((s) => s.id === churnStepId(c, 'remove'))!.scene;
      for (const p of [...VIZ_V3_CHURN_PROBES, ...VIZ_V3_ORDER_PROBES]) {
        expect(
          colorChangeWithin(scene, p.x, p.y, PROBE_MARGIN),
          `cycle ${c}: ${p.name}`,
        ).toBeNull();
      }
    }
    for (const p of [...VIZ_V3_ORDER_PROBES, ...VIZ_V3_CHURN_PROBES]) {
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.y).toBeGreaterThanOrEqual(2);
      expect(p.x).toBeLessThanOrEqual(VIZ_V3_SURFACE.width - 2);
      expect(p.y).toBeLessThanOrEqual(VIZ_V3_SURFACE.height - 2);
    }
  });

  it('separates every order change and the half-opacity and joint candidates by more than twice the tolerance', () => {
    const limit = 2 * PROBE_TOLERANCE;
    let changed = 0;
    for (let index = 1; index < VIZ_V3_ORDER_STATES.length; index += 1) {
      const before = stateScene(script, VIZ_V3_ORDER_STATES[index - 1]!);
      const after = stateScene(script, VIZ_V3_ORDER_STATES[index]!);
      for (const p of VIZ_V3_ORDER_PROBES) {
        const a = at(before, p);
        const b = at(after, p);
        if (a.top === b.top) continue;
        changed += 1;
        expect(
          separation(to8(a), to8(b)),
          `${VIZ_V3_ORDER_STATES[index]}: ${p.name}`,
        ).toBeGreaterThan(limit);
      }
    }
    expect(changed).toBeGreaterThanOrEqual(8);
    // VZ3-A5: both swapped probes change their color by more than twice the tolerance.
    for (const name of VIZ_V3_SWAPPED_PROBES) {
      const s4 = at(stateScene(script, 's4'), probe(name));
      const s5 = at(stateScene(script, 's5'), probe(name));
      expect(s4.top).not.toBe(s5.top);
      expect(separation(to8(s4), to8(s5)), name).toBeGreaterThan(limit);
    }
    // VZ3-A3: in p-joint's stroke-over-fill band the single application differs from the
    // double-opacity value (opacity applied to fill and stroke separately).
    const s0 = script.initial;
    const joint = s0.nodes.find((node) => node.id === 'p-joint')! as RenderNodeSnapshot & {
      kind: 'path';
    };
    const o = joint.opacity;
    const f = joint.style.fill!;
    const s = joint.style.stroke!.color;
    const base = { r: 1, g: 1, b: 1 };
    const single = to8(at(s0, probe(VIZ_V3_JOINT_BAND_PROBE)));
    const doubled = (['r', 'g', 'b'] as const).map((lane) =>
      Math.round(255 * (o * s[lane] + (1 - o) * (o * f[lane] + (1 - o) * base[lane]))),
    );
    expect(separation(single, doubled)).toBeGreaterThan(limit);
    expect(single[1] - (doubled[1] ?? Number.NaN)).toBe(51);
  });

  it('imports no DOM, GPU or WASM code and stays under the host-injection deny-list', () => {
    const source = readFileSync(
      join(__dirname, '../../apps/playground/src/viz-v3-integration-scene.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual([
      '@vector-studio/contracts',
      './p3-b2-strokes-scene.js',
      './p3-v4-paths-scene.js',
    ]);
    expect(source).toMatch(/^import type \{/);
    expect(source).not.toMatch(/\b(document|window|navigator)\.|WebAssembly|GPUDevice|HTMLElement/);
    expect(source).not.toMatch(
      /fillMesh|strokeMesh|geometry-wasm|requiresMeshPipeline|meshPipeline/,
    );
  });
});
