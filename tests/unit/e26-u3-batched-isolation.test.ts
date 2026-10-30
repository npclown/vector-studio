// E26-U3 (E26 contract, section 4.2, E26-A06): batched isolation reaches the result of one set
// per unit (M1 contract, section 5): the same excluded units, the same scene nodes and orders,
// and the same rejection reports in the same order. Seeded documents with nested frames, mask
// groups and deep clip and opacity chains are projected through the real scene mirror, whose own
// rules reject corrupted snapshots (section 3.4): a mask source turned into a container, a clip
// or an opacity that takes a chain past its depth limit, a transform whose world bounds are not
// finite, and a renderer without a path fill port. A pure predicate (one-time and persistent
// rejection of chosen nodes) is run as well; it cannot test batch closure on its own.
// Both projectors share the handling of a unit's own rejection (exclusion, mask group removal),
// so this differential cannot see a fault there; the M1 projector tests check it.
import type { RenderNodeSnapshot, RenderSceneSnapshot } from '@vector-studio/contracts';
import type { DocumentV6 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { createCounterIdSource, createEditor } from '../../packages/editor-core/src/index.js';
import {
  SceneProjector,
  projectPage,
  projectorStateForTesting,
  useOneUnitIsolationForTesting,
} from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

/** mulberry32. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = ReturnType<typeof random>;
type Fields = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' } as const;
const red = { r: 1, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };
const LEAVES = ['rectangle', 'ellipse', 'path'] as const;

/** A v2 node with defaults; `extra` holds the type's fields. */
function node(id: string, parent: string, type: string, extra: Fields = {}): Fields {
  return {
    id,
    name: id,
    parent,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type,
    ...(type === 'rectangle' ? { cornerRadii: [0, 0, 0, 0], fill: red, stroke: null } : {}),
    ...(type === 'ellipse' ? { fill: red, stroke: null } : {}),
    ...(type === 'frame' ? { fill: white, stroke: null } : {}),
    ...(type === 'path'
      ? {
          path: {
            verbs: ['move', 'line', 'line', 'close'],
            points: [0, 0, 1, 0, 0, 1],
            fillRule: 'nonzero',
          },
          fill: red,
          stroke: null,
        }
      : {}),
    ...extra,
  };
}

/**
 * A seeded v2 page: leaves, groups, frames and mask groups (a path source first) up to depth 4,
 * and sometimes a chain of 32 nested frames or of 32 nested half-opaque groups, each at its
 * depth limit, so that one more clip or opacity on the chain is a scene rule violation.
 */
function generate(rng: Rng): DocumentV6 {
  const nodes: Fields[] = [];
  // v2 groups are opaque; the chain's groups get their opacity in v6, after the load.
  const halves: string[] = [];
  let next = 0;
  const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
  const leaf = (parent: string, type: string = pick(LEAVES)) => {
    const id = `n${next++}`;
    nodes.push(node(id, parent, type));
    return id;
  };
  const subtree = (parent: string, depth: number): string => {
    const roll = rng();
    if (depth >= 4 || roll < 0.45) return leaf(parent);
    const id = `n${next++}`;
    const type = roll < 0.65 ? 'group' : roll < 0.85 ? 'frame' : 'maskGroup';
    const entry = node(id, parent, type, { children: [] as string[] });
    nodes.push(entry);
    const children = entry.children as string[];
    if (type === 'maskGroup') children.push(leaf(id, 'path'));
    const count = (type === 'frame' ? 0 : 1) + Math.floor(rng() * 3);
    for (let i = 0; i < count; i += 1) children.push(subtree(id, depth + 1));
    return id;
  };
  const chain = (parent: string, type: 'frame' | 'group'): string => {
    const top = `n${next}`;
    let at = parent;
    for (let level = 0; level < 32; level += 1) {
      const id = `n${next++}`;
      nodes.push(node(id, at, type, { children: [`n${next}`] }));
      if (type === 'group') halves.push(id);
      at = id;
    }
    const end = `n${next}`;
    leaf(at);
    // A sibling leaf above the end, so the chain's nodes are not all one unit path.
    const side = nodes.find((entry) => entry.id === `n${Number(end.slice(1)) - 8}`)!;
    (side.children as string[]).push(leaf(side.id as string));
    return top;
  };
  const roots: string[] = [];
  const count = 2 + Math.floor(rng() * 6);
  for (let i = 0; i < count; i += 1) roots.push(subtree('p', 0));
  if (rng() < 0.5) roots.splice(Math.floor(rng() * roots.length), 0, chain('p', 'frame'));
  if (rng() < 0.5) roots.splice(Math.floor(rng() * roots.length), 0, chain('p', 'group'));
  const editor = createEditor({
    ids: createCounterIdSource('x'),
    document: {
      schemaVersion: 2,
      id: 'doc',
      pages: [{ id: 'p', name: 'Page 1', children: roots }],
      nodes: Object.fromEntries(nodes.map((entry) => [entry.id as string, entry])),
    },
  });
  const document = editor.query({ type: 'document' });
  if (halves.length === 0) return document;
  const updated = { ...document.nodes };
  for (const id of halves) updated[id] = { ...updated[id]!, opacity: 0.5 };
  return { ...document, nodes: updated };
}

type Corruption = 'container' | 'clip' | 'opacity' | 'bounds' | 'predicate';
const RULES: readonly Corruption[] = ['container', 'clip', 'opacity', 'bounds'];

/** `snapshot` turned into a real rule violation of kind `kind` where it applies. */
function corrupt(snapshot: RenderNodeSnapshot, kind: Corruption): RenderNodeSnapshot {
  switch (kind) {
    case 'container':
      // A container mask source breaks P4-S2; elsewhere an empty container is valid.
      return snapshot.kind === 'container'
        ? snapshot
        : {
            id: snapshot.id,
            parentId: snapshot.parentId,
            transform: snapshot.transform,
            visible: snapshot.visible,
            opacity: snapshot.opacity,
            kind: 'container',
            children: [],
            clip: null,
          };
    case 'clip':
      return snapshot.kind === 'container' && snapshot.clip === null
        ? { ...snapshot, clip: { kind: 'rect', x: 0, y: 0, width: 10, height: 10 } }
        : snapshot;
    case 'opacity':
      return { ...snapshot, visible: true, opacity: 0.5 };
    case 'bounds':
      return { ...snapshot, transform: [1e308, 0, 0, 1e308, 0, 0] };
    case 'predicate':
      return snapshot;
  }
}

/**
 * A recording renderer whose sets have the chosen nodes corrupted before the mirror sees them;
 * `predicate` nodes reject the whole set instead (every time, or the first time when `once`).
 */
class CorruptingRenderer extends RecordingRenderer {
  armed = true;
  constructor(
    readonly corruptions: ReadonlyMap<string, Corruption>,
    readonly once: boolean,
    paths: 'supported' | 'unsupported',
  ) {
    super('supported', { pathFills: paths, groupOpacity: 'supported' });
  }

  private hit(nodes: readonly RenderNodeSnapshot[]): boolean {
    if (!this.armed) return false;
    const found = nodes.some((entry) => this.corruptions.get(entry.id) === 'predicate');
    if (found && this.once) this.armed = false;
    return found;
  }

  private corrupted(nodes: readonly RenderNodeSnapshot[]): RenderNodeSnapshot[] {
    return nodes.map((entry) => {
      const kind = this.armed ? this.corruptions.get(entry.id) : undefined;
      return kind === undefined ? entry : corrupt(entry, kind);
    });
  }

  private rejection() {
    return {
      status: 'invalid-scene' as const,
      reason: 'invalid-value' as const,
      current: this.getSynchronizationState().current,
    };
  }

  override replaceSnapshot(snapshot: RenderSceneSnapshot) {
    if (this.hit(snapshot.nodes)) this.overrides.replaceSnapshot = this.rejection();
    return super.replaceSnapshot({ ...snapshot, nodes: this.corrupted(snapshot.nodes) });
  }

  override applyChanges(changes: Parameters<RecordingRenderer['applyChanges']>[0]) {
    if (this.hit([...changes.inserted, ...changes.updated])) {
      this.overrides.applyChanges = this.rejection();
    }
    return super.applyChanges({
      ...changes,
      inserted: this.corrupted(changes.inserted),
      updated: this.corrupted(changes.updated),
    });
  }
}

type Run = { renderer: CorruptingRenderer; projector: SceneProjector; events: unknown[] };

function run(
  corruptions: ReadonlyMap<string, Corruption>,
  once: boolean,
  paths: 'supported' | 'unsupported',
  oneUnit: boolean,
): Run {
  const renderer = new CorruptingRenderer(corruptions, once, paths);
  const events: unknown[] = [];
  const projector = new SceneProjector(
    renderer,
    () => null,
    (event) => events.push(event),
  );
  if (oneUnit) useOneUnitIsolationForTesting(projector);
  return { renderer, projector, events };
}

/** What the result of isolation is compared on: the scene, the exclusions, the reports. */
function outcome({ renderer, projector, events }: Run) {
  const scene = renderer.mirror.readRetainedScene();
  return {
    rootOrder: scene?.rootOrder,
    nodes: scene?.nodes.map((entry) => JSON.stringify(entry)).sort(),
    state: projectorStateForTesting(projector),
    events,
  };
}

const isUnsupported = (event: { reason?: string }) => event.reason === 'unsupported-feature';

const applySets = (renderer: RecordingRenderer, from: number) =>
  renderer.calls.slice(from).filter((call) => call.method === 'applyChanges').length;

describe('E26-U3 batched isolation (E26-A06)', () => {
  it('reaches the one-unit-per-set result on 600 seeded cases against the real mirror', () => {
    const rng = random(0xe26_03);
    const tally = {
      cases: 0,
      isolated: 0,
      fewer: 0,
      rejected: 0,
      masks: 0,
      chains: 0,
      depth: 0,
      pairs: 0,
    };
    for (let index = 0; index < 600; index += 1) {
      const document = generate(rng);
      const projection = projectPage(document, 'p', () => null, new Set());
      const scene = [...projection.nodes.keys()];
      const predicate = rng() < 0.25;
      const corruptions = new Map<string, Corruption>();
      // Half the rule corruptions aim where their rule bites: a mask source, a container.
      const sources = Object.values(document.nodes).flatMap((entry) =>
        entry.type === 'maskGroup' ? [entry.children[0]!] : [],
      );
      const containers = Object.values(document.nodes).flatMap((entry) =>
        entry.type === 'group' || entry.type === 'frame' ? [entry.id] : [],
      );
      const count = 1 + Math.floor(rng() * 4);
      for (let i = 0; i < count; i += 1) {
        const kind = predicate ? 'predicate' : RULES[Math.floor(rng() * RULES.length)]!;
        const aimed =
          kind === 'container' ? sources : kind === 'clip' || kind === 'opacity' ? containers : [];
        const from = aimed.length > 0 && rng() < 0.5 ? aimed : scene;
        corruptions.set(from[Math.floor(rng() * from.length)]!, kind);
      }
      const once = predicate && rng() < 0.5;
      const paths = rng() < 0.15 ? 'unsupported' : 'supported';
      const batched = run(corruptions, once, paths, false);
      const single = run(corruptions, once, paths, true);
      for (const side of [batched, single]) side.projector.replace(document, 'p');
      expect(outcome(batched), `case ${index}`).toEqual(outcome(single));
      const singleSets = applySets(single.renderer, 0);
      const batchedSets = applySets(batched.renderer, 0);
      if (single.renderer.calls[0]!.result.status !== 'applied') {
        tally.isolated += 1;
        if (batchedSets < singleSets) tally.fewer += 1;
      }

      // A retry from an excluded root, with the corruption still on or lifted.
      const excluded = projectorStateForTesting(single.projector).excluded;
      // Reports that only a depth rule can explain: clip and opacity corruptions alone.
      const depthOnly =
        paths === 'supported' &&
        [...corruptions.values()].every((kind) => kind === 'clip' || kind === 'opacity');
      if (depthOnly && (single.events as { reason?: string }[]).some(isUnsupported)) {
        tally.depth += 1;
      }
      if (excluded.length > 0) {
        tally.rejected += 1;
        // One excluded root, or two, so one retry segment writes several scene parents.
        const roots = [excluded[Math.floor(rng() * excluded.length)]!];
        if (excluded.length > 1 && rng() < 0.5) {
          roots.push(excluded.find((id) => id !== roots[0])!);
          tally.pairs += 1;
        }
        const lift = rng() < 0.5;
        for (const side of [batched, single]) {
          side.renderer.armed = !lift && side.renderer.armed;
          side.projector.change(document, 'p', roots);
        }
        expect(outcome(batched), `case ${index} retry`).toEqual(outcome(single));
      }
      if (Object.values(document.nodes).some((entry) => entry.type === 'maskGroup')) {
        tally.masks += 1;
      }
      if (Object.keys(document.nodes).length > 60) tally.chains += 1;
      tally.cases += 1;
    }
    expect(tally.cases).toBe(600);
    // The cases reach isolation, rejections and retries, mask groups, the depth chains and the
    // depth rules, and batching sends fewer sets in most isolations.
    expect(tally.isolated).toBeGreaterThan(400);
    expect(tally.rejected).toBeGreaterThan(350);
    expect(tally.masks).toBeGreaterThan(400);
    expect(tally.chains).toBeGreaterThan(200);
    expect(tally.depth).toBeGreaterThanOrEqual(10);
    expect(tally.pairs).toBeGreaterThan(50);
    expect(tally.fewer).toBeGreaterThan(350);
  });

  it('isolates a one-time rejection in one set, and a persistent one in O(log n) sets', () => {
    const rng = random(7);
    let document = generate(rng);
    while (projectPage(document, 'p', () => null, new Set()).units.length < 40) {
      document = generate(rng);
    }
    const projection = projectPage(document, 'p', () => null, new Set());
    const target = projection.units[Math.floor(projection.units.length / 2)]!;
    const n = projection.units.length;

    const once = run(new Map([[target, 'predicate']]), true, 'supported', false);
    once.projector.replace(document, 'p');
    // The snapshot is rejected, then the empty snapshot and one set of every unit.
    expect(applySets(once.renderer, 0)).toBe(1);
    expect(projectorStateForTesting(once.projector).excluded).toEqual([]);

    const persistent = run(new Map([[target, 'predicate']]), false, 'supported', false);
    persistent.projector.replace(document, 'p');
    const sets = applySets(persistent.renderer, 0);
    expect(sets).toBeLessThanOrEqual(3 * Math.ceil(Math.log2(n)) + 1);
    expect(projectorStateForTesting(persistent.projector).excluded).toEqual([target]);
  });
});
