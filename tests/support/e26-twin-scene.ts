import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  SceneAffine,
  ScenePaint,
} from '@vector-studio/contracts';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import {
  PathMeshPipeline,
  type PathMeshDraw,
  type PathMeshLimits,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import {
  PrimitiveSceneSource,
  useFullDerivationForTesting,
} from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { FakeRaster } from './e28-text-harness.js';
import { ScriptedStrokeMeshPort } from './st-u6-stroke-harness.js';
import { createCountingPort, type ScriptedFillMeshPort } from './v3a-path-harness.js';

// The seeded scenes, sets and twin sources of the E26-U5c differential
// (tests/unit/e26-u5c-incremental-derivation.test.ts), shared with E30-U3's camera-only
// differential (tests/unit/e30-u3-camera-frames.test.ts).

export const identity = { documentId: 'e26-u5c', pageId: 'page' } as const;

/** mulberry32. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
export type Rng = ReturnType<typeof random>;
export type Container = Extract<RenderNodeSnapshot, { kind: 'container' }>;

export const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 480,
  devicePixelRatio: 2,
  sampleCount: 4,
  targetFormat: 'bgra8unorm',
};

export function transform(rng: Rng): SceneAffine {
  const x = Math.round(rng() * 400) - 100;
  const y = Math.round(rng() * 300) - 50;
  if (rng() < 0.7) return [1, 0, 0, 1, x, y];
  const angle = rng() * Math.PI;
  const scale = 0.5 + rng();
  return [
    scale * Math.cos(angle),
    scale * Math.sin(angle),
    -scale * Math.sin(angle),
    scale * Math.cos(angle),
    x,
    y,
  ];
}

export function paint(rng: Rng): ScenePaint {
  if (rng() < 0.15) {
    return {
      kind: rng() < 0.5 ? 'linear' : 'radial',
      transform: [20, 0, 0, 20, 0, 0],
      stops: [
        { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { offset: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
      ],
      spread: 'pad',
    };
  }
  return { r: Math.round(rng() * 8) / 8, g: 0.5, b: 0.25, a: rng() < 0.2 ? 0.5 : 1 };
}

export function leaf(rng: Rng, id: string, parentId: string | null): RenderNodeSnapshot {
  const base = {
    id,
    parentId,
    transform: transform(rng),
    visible: rng() > 0.08,
    opacity: 1,
  };
  const pick = rng();
  if (pick < 0.35) {
    return {
      ...base,
      kind: 'primitive',
      geometry: {
        kind: 'rectangle',
        width: 5 + Math.round(rng() * 40),
        height: 5 + Math.round(rng() * 20),
        cornerRadii: [0, 2, 0, 2],
      },
      style: {
        fill: paint(rng),
        stroke: rng() < 0.6 ? null : { color: paint(rng), width: 1 + Math.round(rng() * 3) },
      },
    };
  }
  if (pick < 0.45) {
    return {
      ...base,
      kind: 'primitive',
      geometry: { kind: 'ellipse', width: 10 + Math.round(rng() * 20), height: 12 },
      style: { fill: paint(rng), stroke: null },
    };
  }
  if (pick < 0.52) {
    return {
      ...base,
      kind: 'primitive',
      geometry: { kind: 'line', start: { x: 0, y: 0 }, end: { x: 30, y: Math.round(rng() * 20) } },
      style: { fill: null, stroke: { color: paint(rng), width: 2 } },
    };
  }
  if (pick < 0.88) {
    // The counting fill port serves a 10 x 10 square tagged by the first point.
    const tag = Math.round(rng() * 60);
    return {
      ...base,
      kind: 'path',
      geometry: {
        kind: 'path',
        verbs: ['move', 'line', 'line', 'close'],
        points: [tag, 0, tag + 10 + Math.round(rng() * 5), 0, tag + 5, 10],
        fillRule: rng() < 0.5 ? 'nonzero' : 'evenodd',
      },
      style: {
        fill: rng() < 0.15 ? null : paint(rng),
        stroke:
          rng() < 0.6
            ? null
            : {
                color: paint(rng),
                width: 1 + Math.round(rng() * 2),
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
    lang: 'ko',
    runs: [
      {
        fontList: '"Arial", sans-serif',
        size: 12 + Math.round(rng() * 8),
        color: { r: 0, g: 0, b: 0, a: 1 },
        clusters: [
          { text: String.fromCodePoint(0x4e00 + Math.floor(rng() * 50)), x: 0, y: 10, advance: 8 },
          { text: String.fromCodePoint(0x4e00 + Math.floor(rng() * 50)), x: 8, y: 10, advance: 8 },
        ],
      },
    ],
  };
}

export function containerNode(rng: Rng, id: string, parentId: string | null): Container {
  const pick = rng();
  return {
    id,
    parentId,
    transform: rng() < 0.5 ? [1, 0, 0, 1, 0, 0] : transform(rng),
    visible: rng() > 0.05,
    opacity: rng() < 0.2 ? 0.5 : rng() < 0.03 ? 0 : 1,
    kind: 'container',
    clip:
      pick < 0.6
        ? null
        : pick < 0.82
          ? { kind: 'rect', x: 0, y: 0, width: 80 + Math.round(rng() * 80), height: 90 }
          : { kind: 'mask' },
    children: [],
  };
}

/** A mask source must be a path with a fill, or a primitive (P4-S2). */
export function maskSource(rng: Rng, id: string, parentId: string): RenderNodeSnapshot {
  for (;;) {
    const node = leaf(rng, id, parentId);
    if (node.kind === 'primitive') return node;
    if (node.kind === 'path' && node.style.fill !== null) return node;
  }
}

/** The scene as plain maps, kept in step with the sets sent to both twins. */
export class Model {
  readonly nodes = new Map<string, RenderNodeSnapshot>();
  rootOrder: string[] = [];
  revision = 1;
  #counter = 0;

  public fresh(): string {
    this.#counter += 1;
    return `n${this.#counter}`;
  }

  public children(parentId: string | null): string[] {
    if (parentId === null) return this.rootOrder;
    return [...(this.nodes.get(parentId) as Container).children];
  }

  public containers(): Container[] {
    return [...this.nodes.values()].filter((node): node is Container => node.kind === 'container');
  }

  public isMask(id: string): boolean {
    const node = this.nodes.get(id);
    return node?.kind === 'container' && node.clip?.kind === 'mask';
  }

  /** Whether `id` is the first child of a mask container. */
  public isMaskSource(id: string): boolean {
    const parentId = this.nodes.get(id)?.parentId ?? null;
    return parentId !== null && this.isMask(parentId) && this.children(parentId)[0] === id;
  }

  public subtree(id: string): string[] {
    const node = this.nodes.get(id)!;
    return node.kind === 'container'
      ? [id, ...node.children.flatMap((child) => this.subtree(child))]
      : [id];
  }

  public snapshot() {
    return {
      identity,
      revision: this.revision,
      nodes: [...this.nodes.values()],
      rootOrder: [...this.rootOrder],
    };
  }
}

export function randomScene(rng: Rng, model: Model, size: number): void {
  const containers: string[] = [];
  const attach = (node: RenderNodeSnapshot) => {
    model.nodes.set(node.id, node);
    if (node.parentId === null) model.rootOrder.push(node.id);
    else {
      const parent = model.nodes.get(node.parentId) as Container;
      model.nodes.set(parent.id, { ...parent, children: [...parent.children, node.id] });
    }
  };
  while (model.nodes.size < size) {
    const parentId =
      containers.length === 0 || rng() < 0.25
        ? null
        : containers[Math.floor(rng() * containers.length)]!;
    if (rng() < 0.2 && containers.length < size / 8) {
      const node = containerNode(rng, model.fresh(), parentId);
      attach(node);
      containers.push(node.id);
      if (node.clip?.kind === 'mask') attach(maskSource(rng, model.fresh(), node.id));
    } else {
      attach(leaf(rng, model.fresh(), parentId));
    }
  }
}

export type Twin = Readonly<{
  mirror: RetainedSceneMirror;
  source: PrimitiveSceneSource;
  served: () => readonly PathMeshDraw[];
  pipeline: PathMeshPipeline;
}>;

export function twin(
  full: boolean,
  limits?: Partial<PathMeshLimits>,
  port: () => ScriptedFillMeshPort = createCountingPort,
): Twin {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    dashes: 'supported',
    clips: 'supported',
    paints: 'gradient',
    groupOpacity: 'supported',
    textNodes: 'supported',
  });
  const pipeline = new PathMeshPipeline({
    port: port(),
    strokePort: new ScriptedStrokeMeshPort(),
    fringeBuilder: buildPathFringe,
    ...(limits === undefined ? {} : { limits }),
  });
  let served: readonly PathMeshDraw[] = [];
  const prepare = pipeline.prepare.bind(pipeline);
  pipeline.prepare = (input) => {
    served = prepare(input);
    return served;
  };
  const source = new PrimitiveSceneSource(mirror, pipeline, { text: { port: new FakeRaster() } });
  if (full) useFullDerivationForTesting(source);
  return { mirror, source, served: () => served, pipeline };
}

/** A packet as plain data: symbols numbered by first appearance in this twin's packets. */
export function normalizer() {
  const symbols = new Map<symbol, number>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'symbol') {
      if (!symbols.has(value)) symbols.set(value, symbols.size);
      return `#${symbols.get(value)}`;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return `${value.constructor.name}:${Buffer.from(bytes).toString('hex')}`;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Map) return [...value].map(([key, entry]) => [walk(key), walk(entry)]);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    }
    return value;
  };
  return (packet: PrimitivePacket | null) => JSON.stringify(walk(packet));
}

/** A random valid set over the model, applied to the model; null when nothing was picked. */
export function randomSet(rng: Rng, model: Model): RenderChangeSet | null {
  const ids = [...model.nodes.keys()];
  if (ids.length === 0) return null;
  const pick = () => ids[Math.floor(rng() * ids.length)]!;
  const inserted: RenderNodeSnapshot[] = [];
  const updated = new Map<string, RenderNodeSnapshot>();
  const removed: string[] = [];
  const orders = new Map<string | null, string[]>();
  const order = (parentId: string | null) => {
    if (!orders.has(parentId)) orders.set(parentId, [...model.children(parentId)]);
    return orders.get(parentId)!;
  };
  const kind = rng();
  if (kind < 0.55) {
    // Leaf edits only, the patched path: one to three leaves restyled or moved in place.
    const count = 1 + Math.floor(rng() * 3);
    for (let index = 0; index < count; index += 1) {
      const id = pick();
      const node = model.nodes.get(id)!;
      if (node.kind === 'container' || updated.has(id)) continue;
      const next = model.isMaskSource(id)
        ? { ...node, transform: transform(rng) }
        : rng() < 0.5
          ? { ...node, transform: transform(rng) }
          : {
              ...leaf(rng, id, node.parentId),
              ...(rng() < 0.5 ? { transform: node.transform } : {}),
            };
      // A leaf of another kind is a different leaf; the patch must fall back for it.
      updated.set(id, next);
    }
  } else if (kind < 0.7) {
    // A container edit: transform, visibility, opacity or clip.
    const containers = model.containers();
    if (containers.length === 0) return null;
    const node = containers[Math.floor(rng() * containers.length)]!;
    const edit = rng();
    updated.set(node.id, {
      ...node,
      ...(edit < 0.4
        ? { transform: transform(rng) }
        : edit < 0.6
          ? { visible: !node.visible }
          : edit < 0.8
            ? { opacity: node.opacity === 1 ? 0.5 : 1 }
            : node.clip?.kind === 'mask'
              ? {}
              : {
                  clip:
                    node.clip === null
                      ? { kind: 'rect', x: 10, y: 10, width: 60, height: 60 }
                      : null,
                }),
    });
  } else if (kind < 0.8) {
    // Insert a leaf or a container under the root or a container.
    const containers = model.containers().filter((node) => node.clip?.kind !== 'mask');
    const parentId =
      containers.length === 0 || rng() < 0.4
        ? null
        : containers[Math.floor(rng() * containers.length)]!.id;
    const node =
      rng() < 0.2
        ? containerNode(rng, model.fresh(), parentId)
        : leaf(rng, model.fresh(), parentId);
    if (node.kind === 'container' && node.clip?.kind === 'mask') return null;
    inserted.push(node);
    const list = order(parentId);
    list.splice(Math.floor(rng() * (list.length + 1)), 0, node.id);
  } else if (kind < 0.9) {
    // Remove a leaf that is not a mask source, or a whole container subtree.
    const id = pick();
    if (model.isMaskSource(id)) return null;
    const node = model.nodes.get(id)!;
    removed.push(...model.subtree(id));
    order(node.parentId).splice(order(node.parentId).indexOf(id), 1);
  } else {
    // Reorder the root or a container that is not a mask.
    const containers = model.containers().filter((node) => node.clip?.kind !== 'mask');
    const parentId =
      containers.length === 0 || rng() < 0.5
        ? null
        : containers[Math.floor(rng() * containers.length)]!.id;
    const list = order(parentId);
    if (list.length < 2) return null;
    const [moved] = list.splice(Math.floor(rng() * list.length), 1);
    list.splice(Math.floor(rng() * (list.length + 1)), 0, moved!);
  }
  if (inserted.length + updated.size + removed.length + orders.size === 0) return null;
  for (const id of removed) model.nodes.delete(id);
  for (const node of [...inserted, ...updated.values()]) model.nodes.set(node.id, node);
  for (const [parentId, children] of orders) {
    if (parentId === null) model.rootOrder = children;
    else {
      const parent = model.nodes.get(parentId) as Container;
      model.nodes.set(parentId, { ...parent, children });
    }
  }
  model.revision += 1;
  return {
    identity,
    revision: model.revision,
    baseRevision: model.revision - 1,
    inserted,
    updated: [...updated.values()],
    removed,
    orders: [...orders].map(([parentId, children]) => ({ parentId, children })),
  };
}

/** Isolation as E26-U5b sends it: one set removing every node, then the page in one set. */
export function isolationSets(model: Model): RenderChangeSet[] {
  const ids = [...model.nodes.keys()].sort();
  const removal: RenderChangeSet = {
    identity,
    revision: model.revision + 1,
    baseRevision: model.revision,
    inserted: [],
    updated: [],
    removed: ids,
    orders: [{ parentId: null, children: [] }],
  };
  const preorder = model.rootOrder.flatMap((id) => model.subtree(id));
  const reinsert: RenderChangeSet = {
    identity,
    revision: model.revision + 2,
    baseRevision: model.revision + 1,
    inserted: preorder.map((id) => model.nodes.get(id)!),
    updated: [],
    removed: [],
    orders: [{ parentId: null, children: [...model.rootOrder] }],
  };
  model.revision += 2;
  return [removal, reinsert];
}

/** What a frame draws, without the history-dependent parts (origins, served exponents). */
export function drawn(twinState: Twin, packet: PrimitivePacket | null) {
  if (packet === null) return null;
  return {
    primitiveDraws: packet.draws.length,
    paths: twinState.served().map((draw) => ({
      nodeId: draw.nodeId,
      paint: draw.paint ?? 'fill',
      orientation: draw.orientation,
      linear: draw.linear,
      opacity: draw.opacity,
      fill: draw.fill,
      composite: draw.composite ?? null,
      maskSource: draw.maskSource ?? false,
    })),
    clipStates: packet.clip?.states.length ?? 0,
    masks: packet.clip?.masks.length ?? 0,
    text: packet.text === undefined ? 0 : packet.text.draws.length,
  };
}
