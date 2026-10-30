// E26-U2 (E26 contract, section 4.1, E26-A07): the incremental scene-set validation returns the
// same `SceneApplyResult` and publishes the same scene, geometry revisions included, as the full
// pre-E26 pipeline (the oracle, `useFullChangeValidationForTesting`), on seeded random scenes and
// change sets that reach every reason `applyChanges` can return; published views stay immutable;
// and a set's node lookups stay within the section 4.1 bound.
import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneApplyResult,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  lastSceneSetVisitsForTesting,
  RetainedSceneMirror,
  setNextGeometryRevisionForTesting,
  useFullChangeValidationForTesting,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';

const identity = { documentId: 'e26-u2', pageId: 'page' } as const;

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
type Container = Extract<RenderNodeSnapshot, { kind: 'container' }>;

const FULL_SUPPORT: RetainedSceneMirrorOptions = {
  pathNodes: 'supported',
  pathFills: 'supported',
  pathStrokes: 'supported',
  clips: 'supported',
  paints: 'gradient',
  dashes: 'supported',
  groupOpacity: 'supported',
  textNodes: 'supported',
};
const NO_SUPPORT: RetainedSceneMirrorOptions = { pathNodes: 'unsupported' };
/** Clips without path fills: a path mask source is unsupported (P4-S2). */
const CLIPS_WITHOUT_PATH_FILLS: RetainedSceneMirrorOptions = {
  ...FULL_SUPPORT,
  pathFills: 'unsupported',
};

/** What a random scene may hold, so that the profile's mirror accepts most scenes. */
type SceneMode = 'any' | 'simple' | 'no-path-fill';

function sceneModeOf(options: RetainedSceneMirrorOptions): SceneMode {
  if (options === NO_SUPPORT) return 'simple';
  if (options === CLIPS_WITHOUT_PATH_FILLS) return 'no-path-fill';
  return 'any';
}

function transform(rng: Rng): SceneAffine {
  if (rng() < 0.5) return [1, 0, 0, 1, Math.round(rng() * 100), Math.round(rng() * 100)];
  const angle = rng() * Math.PI;
  return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), rng() * 50, 0];
}

function leaf(rng: Rng, id: string, parentId: string | null): RenderNodeSnapshot {
  const base = {
    id,
    parentId,
    transform: transform(rng),
    visible: rng() > 0.1,
    opacity: rng() < 0.2 ? 0.5 : 1,
  };
  const pick = rng();
  if (pick < 0.4) {
    return {
      ...base,
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 10 + rng() * 10, height: 5, cornerRadii: [0, 1, 0, 1] },
      style: {
        fill: { r: rng(), g: 0.5, b: 0.5, a: 1 },
        stroke: rng() < 0.5 ? null : { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 },
      },
    };
  }
  if (pick < 0.55) {
    return {
      ...base,
      kind: 'primitive',
      geometry: { kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: rng() * 10 } },
      style: { fill: null, stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 1 } },
    };
  }
  if (pick < 0.85) {
    return {
      ...base,
      kind: 'path',
      geometry: {
        kind: 'path',
        verbs: ['move', 'line', 'line', 'close'],
        points: [0, 0, 10 + Math.round(rng() * 3), 0, 5, 10],
        fillRule: 'nonzero',
      },
      style: {
        fill: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
        stroke:
          rng() < 0.5
            ? null
            : {
                color: { r: 0, g: 0, b: 0, a: 1 },
                width: 1,
                cap: 'butt',
                join: 'miter',
                miterLimit: 4,
                dash: null,
              },
      },
    };
  }
  return {
    ...base,
    kind: 'text',
    generation: 0,
    lang: 'en',
    runs: [
      {
        fontList: '"Inter"',
        size: 12,
        color: { r: 0, g: 0, b: 0, a: 1 },
        clusters: [{ text: 'a', x: 0, y: 10, advance: 6 }],
      },
    ],
  };
}

function containerNode(
  rng: Rng,
  id: string,
  parentId: string | null,
  clip: Container['clip'],
): Container {
  return {
    id,
    parentId,
    transform: transform(rng),
    visible: rng() > 0.05,
    opacity: rng() < 0.2 ? 0.5 : rng() < 0.05 ? 0 : 1,
    kind: 'container',
    clip,
    children: [],
  };
}

/**
 * A random scene of about `size` nodes; mask containers start with a supported source. A
 * `simple` scene holds only containers without clip or group opacity and primitive leaves, so a
 * mirror without optional support accepts it; a `no-path-fill` scene has no path fills and no
 * path mask sources.
 */
function randomScene(
  rng: Rng,
  size: number,
  prefix = 'n',
  mode: SceneMode = 'any',
): RenderSceneSnapshot {
  const simple = mode === 'simple';
  const nodes = new Map<string, RenderNodeSnapshot>();
  const rootOrder: string[] = [];
  const containers: string[] = [];
  let counter = 0;
  const nextId = () => `${prefix}${counter++}`;
  const attach = (node: RenderNodeSnapshot) => {
    nodes.set(node.id, node);
    if (node.parentId === null) rootOrder.push(node.id);
    else {
      const parent = nodes.get(node.parentId) as Container;
      nodes.set(parent.id, { ...parent, children: [...parent.children, node.id] });
    }
  };
  while (nodes.size < size) {
    const parentId =
      containers.length === 0 || rng() < 0.15
        ? null
        : containers[Math.floor(rng() * containers.length)]!;
    if (simple) {
      if (rng() < 0.3) {
        const node = { ...containerNode(rng, nextId(), parentId, null), opacity: 1 };
        attach(node);
        containers.push(node.id);
      } else attach(leafPrimitive(leaf(rng, nextId(), parentId)));
    } else if (rng() < 0.3) {
      const clipPick = rng();
      const clip: Container['clip'] =
        clipPick < 0.6
          ? null
          : clipPick < 0.8
            ? { kind: 'rect', x: 0, y: 0, width: 50, height: 50 }
            : { kind: 'mask' };
      const node = containerNode(rng, nextId(), parentId, clip);
      attach(node);
      containers.push(node.id);
      if (clip?.kind === 'mask') {
        const source = leaf(rng, nextId(), node.id);
        const unsupported =
          source.kind === 'text' || (source.kind === 'path' && mode === 'no-path-fill');
        attach(unsupported ? leafPrimitive(source) : source);
      }
    } else {
      const node = leaf(rng, nextId(), parentId);
      attach(
        node.kind === 'path' && mode === 'no-path-fill'
          ? { ...node, style: { ...node.style, fill: null } }
          : node,
      );
    }
  }
  return { identity, revision: 0, nodes: [...nodes.values()], rootOrder };
}

/** Whether a node isolates its children (E25-S2). */
function isolates(node: RenderNodeSnapshot): boolean {
  return node.kind === 'container' && node.visible && node.opacity > 0 && node.opacity < 1;
}

function leafPrimitive(node: RenderNodeSnapshot): RenderNodeSnapshot {
  return {
    id: node.id,
    parentId: node.parentId,
    transform: node.transform,
    visible: node.visible,
    opacity: node.opacity,
    kind: 'primitive',
    geometry: { kind: 'ellipse', width: 8, height: 8 },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
  };
}

/** The live scene of a mirror, as plain data. */
function sceneOf(mirror: RetainedSceneMirror) {
  const view = mirror.readRetainedScene();
  if (view === null) return null;
  return {
    version: view.version,
    rootOrder: view.rootOrder,
    nodes: view.nodes,
    revisions: view.nodes.map((node) => [node.id, view.getGeometryRevision(node.id)]),
  };
}

/** A random change set over `scene` (the mirror's current data), valid or broken in one way. */
function randomChange(
  rng: Rng,
  scene: NonNullable<ReturnType<typeof sceneOf>>,
  fresh: () => string,
): RenderChangeSet {
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const ids = [...byId.keys()];
  const pickId = () => ids[Math.floor(rng() * ids.length)]!;
  const containers = scene.nodes.filter((node) => node.kind === 'container');
  const revision = scene.version.revision;
  const set = {
    identity,
    baseRevision: revision,
    revision: revision + 1,
    inserted: [] as RenderNodeSnapshot[],
    updated: [] as RenderNodeSnapshot[],
    removed: [] as string[],
    orders: [] as { parentId: string | null; children: string[] }[],
  };
  const listOf = (owner: string | null): string[] => {
    const written = set.orders.find((order) => order.parentId === owner);
    if (written !== undefined) return written.children;
    return owner === null ? [...scene.rootOrder] : [...(byId.get(owner) as Container).children];
  };
  const writeOrder = (owner: string | null, children: string[]) => {
    const existing = set.orders.find((order) => order.parentId === owner);
    if (existing !== undefined) existing.children = children;
    else set.orders.push({ parentId: owner, children });
  };
  const moves = 1 + Math.floor(rng() * 3);
  const touched = new Set<string>();
  for (let step = 0; step < moves; step += 1) {
    const op = rng();
    const id = pickId();
    const node = byId.get(id)!;
    if (touched.has(id)) continue;
    if (op < 0.3) {
      // Restyle or re-transform in place.
      touched.add(id);
      const next =
        node.kind === 'container'
          ? {
              ...node,
              transform: transform(rng),
              opacity: rng() < 0.3 ? 0.5 : 1,
              visible: rng() > 0.1,
              clip: rng() < 0.15 ? ({ kind: 'mask' } as const) : node.clip,
            }
          : { ...leaf(rng, id, node.parentId) };
      set.updated.push(next);
    } else if (op < 0.5 && containers.length > 0) {
      // Move to another parent, keeping both lists consistent.
      const target = rng() < 0.2 ? null : containers[Math.floor(rng() * containers.length)]!.id;
      if (target === node.parentId || target === id) continue;
      touched.add(id);
      set.updated.push({ ...node, parentId: target });
      if (node.parentId !== null && !touched.has(node.parentId)) {
        writeOrder(
          node.parentId,
          listOf(node.parentId).filter((child) => child !== id),
        );
      } else if (node.parentId === null) {
        writeOrder(
          null,
          listOf(null).filter((child) => child !== id),
        );
      }
      if (target === null || !touched.has(target)) {
        const list = listOf(target);
        list.splice(Math.floor(rng() * (list.length + 1)), 0, id);
        writeOrder(target, list);
      }
    } else if (op < 0.7) {
      // Insert a new leaf or container.
      const parent = rng() < 0.2 || containers.length === 0 ? null : containers[0]!.id;
      if (parent !== null && touched.has(parent)) continue;
      const fresh1 = fresh();
      const inserted =
        rng() < 0.3 ? containerNode(rng, fresh1, parent, null) : leaf(rng, fresh1, parent);
      set.inserted.push(inserted);
      const list = listOf(parent);
      list.splice(Math.floor(rng() * (list.length + 1)), 0, fresh1);
      writeOrder(parent, list);
    } else if (op < 0.85) {
      // Remove a leaf.
      if (node.kind === 'container' || (node.parentId !== null && touched.has(node.parentId))) {
        continue;
      }
      touched.add(id);
      set.removed.push(id);
      writeOrder(
        node.parentId,
        listOf(node.parentId).filter((child) => child !== id),
      );
    } else if (node.kind === 'container' && !touched.has(id)) {
      // Reorder a container.
      writeOrder(
        id,
        [...listOf(id)].sort(() => rng() - 0.5),
      );
    }
  }
  if (rng() < 0.08) {
    // A bulk set: more than 16 IDs added and deleted, so the sorted ID list takes a merge pass.
    const bulk = 17 + Math.floor(rng() * 10);
    const added: string[] = [];
    for (let index = 0; index < bulk; index += 1) {
      const bulkId = fresh();
      set.inserted.push(leaf(rng, bulkId, null));
      added.push(bulkId);
    }
    writeOrder(null, [...listOf(null), ...added]);
    for (const entry of scene.nodes) {
      if (set.removed.length >= 10) break;
      if (entry.kind === 'container' || entry.parentId !== null || touched.has(entry.id)) continue;
      touched.add(entry.id);
      set.removed.push(entry.id);
      writeOrder(
        null,
        listOf(null).filter((child) => child !== entry.id),
      );
    }
  }
  // Most sets break in at most one way; some stack breaks, so the category order decides.
  const breaks = rng() < 0.25 ? 2 + Math.floor(rng() * 3) : 1;
  for (let index = 0; index < breaks; index += 1) {
    breakChange(rng, set, scene, byId, pickId, fresh);
  }
  return set;
}

/** Breaks a change set in one of many ways, about half of the time. */
function breakChange(
  rng: Rng,
  set: {
    identity: typeof identity;
    baseRevision: number;
    revision: number;
    inserted: RenderNodeSnapshot[];
    updated: RenderNodeSnapshot[];
    removed: string[];
    orders: { parentId: string | null; children: string[] }[];
  },
  scene: NonNullable<ReturnType<typeof sceneOf>>,
  byId: Map<string, RenderNodeSnapshot>,
  pickId: () => string,
  fresh: () => string,
): void {
  if (rng() < 0.45) return;
  const pick = Math.floor(rng() * 32);
  const id = pickId();
  const node = byId.get(id)!;
  const containers = scene.nodes.filter((entry) => entry.kind === 'container');
  const leaves = scene.nodes.filter((entry) => entry.kind !== 'container');
  const listOf = (owner: string | null): string[] => {
    const written = set.orders.find((order) => order.parentId === owner);
    if (written !== undefined) return written.children;
    return owner === null ? [...scene.rootOrder] : [...(byId.get(owner) as Container).children];
  };
  const writeOrder = (owner: string | null, children: string[]) => {
    const existing = set.orders.find((order) => order.parentId === owner);
    if (existing !== undefined) existing.children = children;
    else set.orders.push({ parentId: owner, children });
  };
  /** A chain of `length` fresh containers under the root; returns the chain. */
  const chain = (length: number, link: (chainId: string, parent: string | null) => Container) => {
    let parent: string | null = null;
    const nodes: Container[] = [];
    for (let level = 0; level < length; level += 1) {
      const chainId = fresh();
      nodes.push(link(chainId, parent));
      if (level > 0) nodes[level - 1] = { ...nodes[level - 1]!, children: [chainId] };
      parent = chainId;
    }
    set.inserted.push(...nodes);
    writeOrder(null, [...listOf(null), nodes[0]!.id]);
    return nodes;
  };
  /** A chain link that clips, below a head that does not (so a later set can toggle it). */
  const clipLink = (chainId: string, parent: string | null): Container => ({
    ...containerNode(
      rng,
      chainId,
      parent,
      parent === null ? null : { kind: 'rect', x: 0, y: 0, width: 9, height: 9 },
    ),
    visible: true,
    opacity: 1,
  });
  switch (pick) {
    case 0: // stale base
      set.baseRevision -= 1;
      break;
    case 1: // revision not after base
      set.revision = set.baseRevision;
      break;
    case 2: // other identity
      (set as { identity: unknown }).identity = { documentId: 'other', pageId: 'page' };
      break;
    case 3: // non-finite world arithmetic
      set.updated.push({ ...node, transform: [1e308, 0, 0, 1e308, 0, 0] });
      break;
    case 4: // duplicate inserted ID
      set.inserted.push(leaf(rng, id, null));
      break;
    case 5: // duplicate within updated
      set.updated.push(node, node);
      break;
    case 6: // conflicting update and removal
      set.updated.push(node);
      set.removed.push(id);
      break;
    case 7: // update of an unknown node
      set.updated.push(leaf(rng, fresh(), null));
      break;
    case 8: // order naming an unknown child
      set.orders.push({ parentId: null, children: [...scene.rootOrder, fresh()] });
      break;
    case 9: // removal still listed by its parent
      if (node.kind !== 'container') set.removed.push(id);
      break;
    case 10: // order for a leaf parent
      if (node.kind !== 'container') set.orders.push({ parentId: id, children: [] });
      break;
    case 11: // parent that is a leaf
      if (node.kind !== 'container') set.inserted.push(leaf(rng, fresh(), id));
      break;
    case 12: // cycle: a container under its own child container
      for (const entry of containers) {
        const child = entry.children
          .map((childId) => byId.get(childId)!)
          .find((candidate) => candidate.kind === 'container');
        if (child !== undefined) {
          set.updated.push({ ...entry, parentId: child.id });
          break;
        }
      }
      break;
    case 13: // move without updating any list
      if (containers.length > 0) {
        set.updated.push({ ...node, parentId: containers[0]!.id });
      }
      break;
    case 14: // order dropping a child that stays
      if (scene.rootOrder.length > 1) {
        set.orders.push({ parentId: null, children: scene.rootOrder.slice(1) });
      }
      break;
    case 15: // order listing a child twice
      set.orders.push({ parentId: null, children: [...scene.rootOrder, scene.rootOrder[0]!] });
      break;
    case 16: // mask whose source is a container
      for (const entry of containers) {
        const children = entry.children;
        if (children.length > 0 && byId.get(children[0]!)!.kind === 'container') {
          set.updated.push({ ...entry, clip: { kind: 'mask' } });
          break;
        }
      }
      break;
    case 17: // clip depth at and past SCENE_MAX_CLIP_DEPTH: a plain head over 32 or 33 clips (the bottom clip at or past the limit)
      chain(33 + Math.floor(rng() * 2), clipLink);
      break;
    case 18: // isolation depth: the same with opacity 0.5 and no clip
      chain(33 + Math.floor(rng() * 2), (chainId, parent) => ({
        ...containerNode(rng, chainId, parent, null),
        visible: true,
        opacity: parent === null ? 1 : 0.5,
      }));
      break;
    case 19: // shape garbage
      (set.updated as unknown[]).push({ id: 'x' });
      break;
    case 20: // order for a container that is also updated
      if (node.kind === 'container') {
        set.updated.push(node);
        set.orders.push({ parentId: id, children: [...node.children] });
      }
      break;
    case 21: // kind change: a leaf becomes an empty container, a container a leaf
      set.updated.push(
        node.kind === 'container'
          ? leafPrimitive(node)
          : { ...containerNode(rng, id, node.parentId, null), transform: node.transform },
      );
      break;
    case 22: // a node made its own parent
      set.updated.push({ ...node, parentId: id });
      break;
    case 23: {
      // a node moved under a leaf, both lists written
      const target = leaves[Math.floor(rng() * leaves.length)];
      if (target === undefined || target.id === id) break;
      set.updated.push({ ...node, parentId: target.id });
      writeOrder(
        node.parentId,
        listOf(node.parentId).filter((child) => child !== id),
      );
      break;
    }
    case 24: // a node moved under an unknown parent
      set.updated.push({ ...node, parentId: fresh() });
      writeOrder(
        node.parentId,
        listOf(node.parentId).filter((child) => child !== id),
      );
      break;
    case 25: {
      // an inserted container adopts an existing node (consistent)
      const adopter = { ...containerNode(rng, fresh(), null, null), children: [id] };
      set.inserted.push(adopter);
      set.updated.push({ ...node, parentId: adopter.id });
      writeOrder(
        node.parentId,
        listOf(node.parentId).filter((child) => child !== id),
      );
      writeOrder(null, [...listOf(null), adopter.id]);
      break;
    }
    case 26: {
      // a container removed with its whole subtree (consistent)
      const target = containers[Math.floor(rng() * containers.length)];
      if (target === undefined) break;
      const pending = [target.id];
      while (pending.length > 0) {
        const next = pending.pop()!;
        set.removed.push(next);
        const entry = byId.get(next)!;
        if (entry.kind === 'container') pending.push(...entry.children);
      }
      writeOrder(
        target.parentId,
        listOf(target.parentId).filter((child) => child !== target.id),
      );
      break;
    }
    case 27: {
      // composition overflow: each scale is finite, the product is not
      const parent = containers.find((entry) => entry.children.length > 0);
      if (parent === undefined) break;
      const child = byId.get(parent.children[0]!)!;
      set.updated.push(
        { ...parent, transform: [1e155, 0, 0, 1e155, 0, 0] },
        { ...child, transform: [1e155, 0, 0, 1e155, 0, 0] },
      );
      break;
    }
    case 28: {
      // clip or isolation depth reached by a toggle: the plain container above the deepest chain
      // starts clipping or isolating
      const isolation = rng() < 0.5;
      const counts = (entry: Container) => (isolation ? isolates(entry) : entry.clip !== null);
      const height = new Map<string, number>();
      const heightOf = (entryId: string): number => {
        const known = height.get(entryId);
        if (known !== undefined) return known;
        const entry = byId.get(entryId)!;
        let result = 0;
        if (entry.kind === 'container') {
          for (const childId of entry.children) result = Math.max(result, heightOf(childId));
          if (counts(entry)) result += 1;
        }
        height.set(entryId, result);
        return result;
      };
      let best: Container | undefined;
      for (const entry of containers) {
        if (counts(entry)) continue;
        if (best === undefined || heightOf(entry.id) > heightOf(best.id)) best = entry;
      }
      if (best !== undefined) {
        set.updated.push(
          isolation
            ? { ...best, visible: true, opacity: 0.5 }
            : { ...best, clip: { kind: 'rect', x: 0, y: 0, width: 9, height: 9 } },
        );
      }
      break;
    }
    case 29: {
      // clip depth reached by a move: a node moves to the bottom of a fresh chain of 30 to 32
      // clips
      const links = chain(31 + Math.floor(rng() * 3), clipLink);
      const bottom = links.length - 1;
      links[bottom] = { ...links[bottom]!, children: [id] };
      set.inserted.splice(set.inserted.length - links.length, links.length, ...links);
      set.updated.push({ ...node, parentId: links[bottom].id });
      writeOrder(
        node.parentId,
        listOf(node.parentId).filter((child) => child !== id),
      );
      break;
    }
    case 30: {
      // non-finite arithmetic below a re-transformed container, two levels down
      const target = containers.find((entry) =>
        entry.children.some((childId) => {
          const child = byId.get(childId)!;
          return child.kind === 'container' && child.children.length > 0;
        }),
      );
      if (target !== undefined)
        set.updated.push({ ...target, transform: [1e307, 0, 0, 1e307, 0, 0] });
      break;
    }
    default: // remove a container but not its children
      for (const entry of containers) {
        const children = entry.children;
        if (children.length === 0) continue;
        set.removed.push(entry.id);
        if (entry.parentId === null) {
          set.orders.push({
            parentId: null,
            children: scene.rootOrder.filter((childId) => childId !== entry.id),
          });
        }
        break;
      }
  }
}

function describeResult(result: SceneApplyResult): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

describe('E26-U2 incremental scene-set validation (E26-A07)', () => {
  for (const [label, options] of [
    ['full support', FULL_SUPPORT],
    ['no support', NO_SUPPORT],
    ['clips without path fills', CLIPS_WITHOUT_PATH_FILLS],
  ] as const) {
    it(`equals the full pipeline on seeded random sets (${label})`, () => {
      const outcomes = new Map<string, number>();
      let sets = 0;
      let scenes = 0;
      let accepted = 0;
      for (let seed = 1; sets < 2_000; seed += 1) {
        const rng = random(seed * 7919);
        const incremental = new RetainedSceneMirror(() => undefined, options);
        const oracle = new RetainedSceneMirror(() => undefined, options);
        useFullChangeValidationForTesting(oracle);
        const mode = sceneModeOf(options);
        const snapshot = randomScene(rng, 10 + Math.floor(rng() * 40), `s${seed}-`, mode);
        const first = incremental.replaceSnapshot(snapshot);
        expect(oracle.replaceSnapshot(snapshot)).toEqual(first);
        scenes += 1;
        if (first.status !== 'applied') continue;
        accepted += 1;
        let counter = 0;
        const fresh = () => `f${seed}-${counter++}`;
        for (let step = 0; step < 20; step += 1) {
          if (rng() < 0.02) {
            // The geometry revision counter at its end (P3 V3, section b).
            const next = Number.MAX_SAFE_INTEGER - Math.floor(rng() * 3);
            setNextGeometryRevisionForTesting(incremental, next);
            setNextGeometryRevisionForTesting(oracle, next);
          }
          if (rng() < 0.04) {
            // A snapshot between sets.
            const replacement = {
              ...randomScene(rng, 10 + Math.floor(rng() * 40), `r${seed}-${step}-`, mode),
              revision: sceneOf(oracle)!.version.revision + 1,
            };
            expect(incremental.replaceSnapshot(replacement)).toEqual(
              oracle.replaceSnapshot(replacement),
            );
          }
          // The set is drawn from the oracle's view, and the incremental view is read on about
          // half of the steps, so that sets also apply to a scene no reader has copied.
          const change = randomChange(rng, sceneOf(oracle)!, fresh);
          const expected = oracle.applyChanges(change);
          const actual = incremental.applyChanges(change);
          expect(actual, `seed ${seed} step ${step}`).toEqual(expected);
          if (rng() < 0.5) expect(sceneOf(incremental)).toEqual(sceneOf(oracle));
          sets += 1;
          const key = describeResult(actual);
          outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
          if (actual.status === 'resync-required') {
            // Both mirrors now require a snapshot: start a new scene.
            break;
          }
        }
        expect(sceneOf(incremental)).toEqual(sceneOf(oracle));
      }
      // Most random scenes are valid, so the sets start from varied scenes.
      expect(accepted / scenes).toBeGreaterThan(0.8);
      const reasons = [...outcomes.keys()].sort();
      if (options === FULL_SUPPORT) {
        expect(reasons).toEqual([
          'applied',
          'conflicting-operation',
          'cycle',
          'duplicate-id',
          'invalid-order',
          'invalid-parent',
          'invalid-value',
          'resync-required',
          'unknown-node',
          'unsupported-feature',
        ]);
      } else {
        expect(reasons).toContain('unsupported-feature');
        expect(reasons).toContain('applied');
      }
    }, 60_000);
  }

  it('equals the full pipeline when a toggle or a move reaches the depth limits', () => {
    // A plain head over `count` clipping (or isolating) containers, then a set that does not
    // write the chain: the head starts clipping (or isolating), or a clipping node moves under
    // the bottom, or the chain moves under that node. Counts 32 and 33 put the bottom at and past the limit after the change.
    for (const isolation of [false, true]) {
      for (const count of [31, 32, 33]) {
        for (const change of ['toggle', 'move', 'move-chain'] as const) {
          const rng = random(count * 2 + (isolation ? 1 : 0));
          const link = (id: string, parentId: string | null, child: string | null): Container => ({
            ...containerNode(rng, id, parentId, null),
            visible: true,
            opacity: isolation && parentId !== null ? 0.5 : 1,
            clip:
              !isolation && parentId !== null
                ? { kind: 'rect', x: 0, y: 0, width: 9, height: 9 }
                : null,
            children: child === null ? [] : [child],
          });
          const nodes: RenderNodeSnapshot[] = [];
          for (let level = 0; level <= count; level += 1) {
            nodes.push(
              link(
                `c${level}`,
                level === 0 ? null : `c${level - 1}`,
                level === count ? null : `c${level + 1}`,
              ),
            );
          }
          const mover = {
            ...link('m', null, null),
            opacity: isolation ? 0.5 : 1,
            clip: isolation ? null : ({ kind: 'rect', x: 0, y: 0, width: 9, height: 9 } as const),
          };
          nodes.push(mover);
          const snapshot = { identity, revision: 0, nodes, rootOrder: ['c0', 'm'] };
          const set: RenderChangeSet =
            change === 'toggle'
              ? {
                  identity,
                  baseRevision: 0,
                  revision: 1,
                  inserted: [],
                  updated: [
                    isolation
                      ? { ...nodes[0]!, opacity: 0.5 }
                      : {
                          ...(nodes[0] as Container),
                          clip: { kind: 'rect', x: 0, y: 0, width: 9, height: 9 },
                        },
                  ],
                  removed: [],
                  orders: [],
                }
              : change === 'move-chain'
                ? {
                    identity,
                    baseRevision: 0,
                    revision: 1,
                    inserted: [],
                    updated: [{ ...nodes[1]!, parentId: 'm' }],
                    removed: [],
                    orders: [
                      { parentId: 'c0', children: [] },
                      { parentId: 'm', children: ['c1'] },
                    ],
                  }
                : {
                    identity,
                    baseRevision: 0,
                    revision: 1,
                    inserted: [],
                    updated: [{ ...mover, parentId: `c${count}` }],
                    removed: [],
                    orders: [
                      { parentId: null, children: ['c0'] },
                      { parentId: `c${count}`, children: ['m'] },
                    ],
                  };
          const incremental = new RetainedSceneMirror(() => undefined, FULL_SUPPORT);
          const oracle = new RetainedSceneMirror(() => undefined, FULL_SUPPORT);
          useFullChangeValidationForTesting(oracle);
          const first = incremental.replaceSnapshot(snapshot);
          expect(oracle.replaceSnapshot(snapshot)).toEqual(first);
          const label = `${isolation ? 'isolation' : 'clip'} ${count} ${change}`;
          expect(first.status, label).toBe(count <= 33 ? 'applied' : 'invalid-scene');
          const expected = oracle.applyChanges(set);
          expect(incremental.applyChanges(set), label).toEqual(expected);
          expect(describeResult(expected), label).toBe(
            count + 1 > 33 ? 'unsupported-feature' : 'applied',
          );
          expect(sceneOf(incremental)).toEqual(sceneOf(oracle));
        }
      }
    }
  });

  it('keeps a published view unchanged after later sets and snapshots', () => {
    const rng = random(42);
    const mirror = new RetainedSceneMirror(() => undefined, FULL_SUPPORT);
    expect(mirror.replaceSnapshot(randomScene(rng, 30, 'n', 'simple')).status).toBe('applied');
    let counter = 0;
    let bulkSets = 0;
    for (let step = 0; step < 200; step += 1) {
      const view = mirror.readRetainedScene()!;
      const frozen = JSON.stringify({
        nodes: view.nodes,
        each: view.nodes.map((node) => [view.getNode(node.id), view.getGeometryRevision(node.id)]),
        rootOrder: view.rootOrder,
      });
      const ids = view.nodes.map((node) => node.id);
      if (step % 25 === 24) {
        // A snapshot of a larger scene with any feature.
        const revision = view.version.revision + 1;
        mirror.replaceSnapshot({ ...randomScene(rng, 120, `r${step}-`), revision });
      } else {
        const change = randomChange(rng, sceneOf(mirror)!, () => `v${counter++}`);
        if (change.inserted.length + change.removed.length > 16) bulkSets += 1;
        mirror.applyChanges(change);
      }
      expect(
        JSON.stringify({
          nodes: view.nodes,
          each: ids.map((id) => [view.getNode(id), view.getGeometryRevision(id)]),
          rootOrder: view.rootOrder,
        }),
      ).toBe(frozen);
    }
    expect(bulkSets).toBeGreaterThan(0);
  });

  it('bounds the node lookups of a set by its size, depth and moved subtrees', () => {
    // A wide and deep scene: 100 groups of 100 leaves, one group nested 20 deep.
    const nodes: RenderNodeSnapshot[] = [];
    const rootOrder: string[] = [];
    const leafAt = (id: string, parentId: string): RenderNodeSnapshot => ({
      id,
      parentId,
      transform: [1, 0, 0, 1, 1, 1],
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 2, height: 2, cornerRadii: [0, 0, 0, 0] },
      style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
    });
    const group = (
      id: string,
      parentId: string | null,
      children: string[],
    ): RenderNodeSnapshot => ({
      id,
      parentId,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      clip: null,
      children,
    });
    for (let g = 0; g < 100; g += 1) {
      const children = Array.from({ length: 100 }, (_, i) => `l${g}-${i}`);
      nodes.push(group(`g${g}`, null, children));
      rootOrder.push(`g${g}`);
      for (const id of children) nodes.push(leafAt(id, `g${g}`));
    }
    let parent = 'g0';
    for (let level = 0; level < 20; level += 1) {
      const id = `d${level}`;
      nodes.push(group(id, parent, []));
      const owner = nodes.find((node) => node.id === parent) as Container;
      nodes[nodes.indexOf(owner)] = { ...owner, children: [...owner.children, id] };
      parent = id;
    }
    nodes.push(leafAt('deep', parent));
    const deepest = nodes.find((node) => node.id === parent) as Container;
    nodes[nodes.indexOf(deepest)] = { ...deepest, children: ['deep'] };

    const mirror = new RetainedSceneMirror(() => undefined, FULL_SUPPORT);
    expect(mirror.replaceSnapshot({ identity, revision: 0, nodes, rootOrder }).status).toBe(
      'applied',
    );
    const n = nodes.length;
    /** Section 4.1 bound; `l` sums the old and new lengths of the lists the set writes. */
    const bound = (k: number, d: number, s: number, l = 0) =>
      U2_VISIT_CONSTANT * (k * (d + Math.log2(n)) + l + s);
    let revision = 0;
    const visits: number[] = [];
    const apply = (fields: Partial<RenderChangeSet>) => {
      const result = mirror.applyChanges({
        identity,
        baseRevision: revision,
        revision: revision + 1,
        inserted: [],
        updated: [],
        removed: [],
        orders: [],
        ...fields,
      });
      expect(result.status).toBe('applied');
      revision += 1;
      const count = lastSceneSetVisitsForTesting(mirror);
      visits.push(count);
      return count;
    };

    // A leaf restyle at depth 22: k = 1, S = 0.
    const deep = nodes.find((node) => node.id === 'deep')!;
    expect(apply({ updated: [{ ...deep, opacity: 0.5 }] })).toBeLessThanOrEqual(bound(1, 22, 0));
    // A leaf restyle in a group of 100 siblings: siblings are not visited.
    const sibling = nodes.find((node) => node.id === 'l50-50')!;
    expect(apply({ updated: [{ ...sibling, opacity: 0.5 }] })).toBeLessThanOrEqual(bound(1, 1, 0));
    // A group moved by its transform: its 100 leaves are its subtree S.
    const moved = nodes.find((node) => node.id === 'g7')!;
    expect(apply({ updated: [{ ...moved, transform: [1, 0, 0, 1, 5, 5] }] })).toBeLessThanOrEqual(
      bound(1, 0, 100),
    );
    // An insertion into a group of 100: the written list, 100 entries before and 101 after.
    const g9 = nodes.find((node) => node.id === 'g9') as Container;
    expect(
      apply({
        inserted: [leafAt('new', 'g9')],
        orders: [{ parentId: 'g9', children: [...g9.children, 'new'] }],
      }),
    ).toBeLessThanOrEqual(bound(1, 1, 0, 201));
    // A removal from a group of 100: the written list, 100 entries before and 99 after.
    const g20 = nodes.find((node) => node.id === 'g20') as Container;
    expect(
      apply({
        removed: ['l20-5'],
        orders: [{ parentId: 'g20', children: g20.children.filter((id) => id !== 'l20-5') }],
      }),
    ).toBeLessThanOrEqual(bound(1, 1, 0, 199));
    // A reparent between two groups of 100: both written lists, before and after.
    const g30 = nodes.find((node) => node.id === 'g30') as Container;
    const g31 = nodes.find((node) => node.id === 'g31') as Container;
    const movedLeaf = nodes.find((node) => node.id === 'l30-0')!;
    expect(
      apply({
        updated: [{ ...movedLeaf, parentId: 'g31' }],
        orders: [
          { parentId: 'g30', children: g30.children.filter((id) => id !== 'l30-0') },
          { parentId: 'g31', children: [...g31.children, 'l30-0'] },
        ],
      }),
    ).toBeLessThanOrEqual(bound(1, 1, 0, 400));
    // A clip toggled on a group of 100: its leaves are the subtree whose depth inputs change.
    const g40 = nodes.find((node) => node.id === 'g40') as Container;
    expect(
      apply({ updated: [{ ...g40, clip: { kind: 'rect', x: 0, y: 0, width: 9, height: 9 } }] }),
    ).toBeLessThanOrEqual(bound(1, 0, 100));
    // A set rejected before its candidate is built counts no lookups.
    expect(
      mirror.applyChanges({
        identity,
        baseRevision: revision,
        revision,
        inserted: [],
        updated: [],
        removed: [],
        orders: [],
      }).status,
    ).toBe('invalid-scene');
    expect(lastSceneSetVisitsForTesting(mirror)).toBe(0);
    // None of these sets comes near the size of the scene.
    expect(Math.max(...visits)).toBeLessThan(n / 10);
  });
});

/** The constant c of the E26-A07 bound, fixed by U2. */
const U2_VISIT_CONSTANT = 4;
