import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';

// Seeded primitives for the packing-bound tests (E26-U5d-1, E30-U3b).

export type PrimitiveNode = Extract<RenderNodeSnapshot, { kind: 'primitive' }>;

/** mulberry32. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function primitive(rng: () => number, world: SceneAffine): PrimitiveNode {
  const width = 10 ** (rng() * 6 - 2);
  const height = 10 ** (rng() * 6 - 2);
  const stroke = rng() < 0.5 ? null : { color: { r: 0, g: 0, b: 0, a: 1 }, width: rng() * 20 };
  const kind = rng();
  const geometry: PrimitiveNode['geometry'] =
    kind < 0.4
      ? {
          kind: 'rectangle',
          width,
          height,
          cornerRadii: [rng() * width, rng() * width, rng() * height, rng() * height],
        }
      : kind < 0.7
        ? { kind: 'ellipse', width, height }
        : {
            kind: 'line',
            start: { x: (rng() - 0.5) * width, y: (rng() - 0.5) * height },
            end: { x: (rng() - 0.5) * width, y: (rng() - 0.5) * height },
          };
  return {
    id: 'p',
    parentId: null,
    transform: world,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry,
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke },
  };
}

export function localBounds(node: PrimitiveNode) {
  const half = (node.style.stroke?.width ?? 0) / 2;
  const geometry = node.geometry;
  if (geometry.kind === 'line') {
    return {
      minX: Math.min(geometry.start.x, geometry.end.x) - half,
      minY: Math.min(geometry.start.y, geometry.end.y) - half,
      maxX: Math.max(geometry.start.x, geometry.end.x) + half,
      maxY: Math.max(geometry.start.y, geometry.end.y) + half,
    };
  }
  return { minX: -half, minY: -half, maxX: geometry.width + half, maxY: geometry.height + half };
}
