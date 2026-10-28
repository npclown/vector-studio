import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneColor,
} from '@vector-studio/contracts';

// P4 contract, unit U5 (docs/plans/p4-clip-mask.md, sections 3 and 6): the scenes and the CPU
// oracle of the headed clip and mask spec. Scenes are written in world space (each node's world
// affine) and converted to the snapshot's parent-relative transforms here, so a case states
// where things are rather than how the chain composes. The oracle evaluates section 3 at pixel
// centres: a probe is "interior" when it is at least 2 physical px from every shape and clip
// edge that affects it, and then the expected colour is the source-over composite of the drawn
// leaves in paint order over the opaque black clear. Edge pixels are checked against the
// references of P4-K1 and P4-K2 (see `levelReference`), which the spec renders on the GPU.

/** `[a, b, c, d, e, f]`: x' = a x + c y + e, y' = b x + d y + f (the scene's convention). */
export type Affine = readonly [number, number, number, number, number, number];
export type Rgba = Readonly<{ r: number; g: number; b: number; a: number }>;

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
export const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };

/** `m ∘ n`: applies n first. */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function transformPoint(m: Affine, x: number, y: number): readonly [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function translate(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}

/** Rotation by `degrees` about the origin, then a translation to (x, y). */
export function rotate(degrees: number, x = 0, y = 0): Affine {
  const angle = (degrees * Math.PI) / 180;
  return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), x, y];
}

export function scale(sx: number, sy = sx): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

export type P4Shape =
  | Readonly<{ kind: 'rectangle'; width: number; height: number }>
  | Readonly<{ kind: 'ellipse'; width: number; height: number }>
  | Readonly<{ kind: 'line'; start: readonly [number, number]; end: readonly [number, number] }>
  | Readonly<{
      kind: 'path';
      /** Closed polygons, flat x, y lists. */
      subpaths: readonly (readonly number[])[];
      fillRule: 'nonzero' | 'evenodd';
    }>;

export type P4Leaf = Readonly<{
  type: 'leaf';
  id: string;
  shape: P4Shape;
  world: Affine;
  fill: Rgba | null;
  opacity?: number;
  visible?: boolean;
}>;

export type P4Clip =
  | null
  | Readonly<{ kind: 'rect'; x: number; y: number; width: number; height: number }>
  | Readonly<{ kind: 'mask' }>;

export type P4Container = Readonly<{
  type: 'container';
  id: string;
  world: Affine;
  clip: P4Clip;
  children: readonly P4Item[];
  visible?: boolean;
}>;

export type P4Item = P4Leaf | P4Container;

export function leaf(
  id: string,
  shape: P4Shape,
  world: Affine,
  fill: Rgba | null = WHITE,
  extra: Partial<Pick<P4Leaf, 'opacity' | 'visible'>> = {},
): P4Leaf {
  return { type: 'leaf', id, shape, world, fill, ...extra };
}

export function container(
  id: string,
  world: Affine,
  clip: P4Clip,
  children: readonly P4Item[],
  extra: Partial<Pick<P4Container, 'visible'>> = {},
): P4Container {
  return { type: 'container', id, world, clip, children, ...extra };
}

export const rect = (width: number, height: number): P4Shape => ({
  kind: 'rectangle',
  width,
  height,
});
export const ellipse = (width: number, height: number): P4Shape => ({
  kind: 'ellipse',
  width,
  height,
});
export const polygon = (
  subpaths: readonly (readonly number[])[],
  fillRule: 'nonzero' | 'evenodd' = 'nonzero',
): P4Shape => ({ kind: 'path', subpaths, fillRule });

function color(value: Rgba): SceneColor {
  return { r: value.r, g: value.g, b: value.b, a: value.a };
}

function nodeOf(item: P4Item, parentId: string | null, parentWorld: Affine): RenderNodeSnapshot {
  // A singular parent has no inverse; its children keep their world affine as local (they are
  // not drawn either way, P4-K2b).
  const singular =
    Math.abs(parentWorld[0] * parentWorld[3] - parentWorld[1] * parentWorld[2]) < 1e-300;
  const transform = singular ? item.world : multiply(invert(parentWorld), item.world);
  const base = {
    id: item.id,
    parentId,
    transform: transform,
    visible: item.visible ?? true,
    opacity: item.type === 'leaf' ? (item.opacity ?? 1) : 1,
  };
  if (item.type === 'container') {
    return {
      ...base,
      kind: 'container',
      children: item.children.map((child) => child.id),
      clip: item.clip,
    };
  }
  const style = { fill: item.fill === null ? null : color(item.fill), stroke: null };
  const shape = item.shape;
  if (shape.kind === 'path') {
    const verbs: ('move' | 'line' | 'close')[] = [];
    const points: number[] = [];
    for (const subpath of shape.subpaths) {
      for (let index = 0; index < subpath.length; index += 2) {
        verbs.push(index === 0 ? 'move' : 'line');
        points.push(subpath[index]!, subpath[index + 1]!);
      }
      verbs.push('close');
    }
    return {
      ...base,
      kind: 'path',
      geometry: { kind: 'path', verbs, points, fillRule: shape.fillRule },
      style,
    };
  }
  const geometry =
    shape.kind === 'rectangle'
      ? { kind: 'rectangle', width: shape.width, height: shape.height, cornerRadii: [0, 0, 0, 0] }
      : shape.kind === 'ellipse'
        ? { kind: 'ellipse', width: shape.width, height: shape.height }
        : {
            kind: 'line',
            start: { x: shape.start[0], y: shape.start[1] },
            end: { x: shape.end[0], y: shape.end[1] },
          };
  return { ...base, kind: 'primitive', geometry, style } as RenderNodeSnapshot;
}

/** The snapshot of top-level `items` in paint order (revision is set by the page). */
export function snapshotOf(items: readonly P4Item[]): RenderSceneSnapshot {
  const nodes: RenderNodeSnapshot[] = [];
  const walk = (item: P4Item, parentId: string | null, parentWorld: Affine) => {
    nodes.push(nodeOf(item, parentId, parentWorld));
    if (item.type === 'container') {
      for (const child of item.children) walk(child, item.id, item.world);
    }
  };
  for (const item of items) walk(item, null, IDENTITY);
  return {
    identity: { documentId: 'p4-u5', pageId: 'page' },
    revision: 1,
    rootOrder: items.map((item) => item.id),
    nodes,
  };
}

/** The clip depth of the deepest node (P4 section 2). */
export function maxClipDepth(items: readonly P4Item[]): number {
  let deepest = 0;
  const walk = (item: P4Item, depth: number) => {
    deepest = Math.max(deepest, depth);
    if (item.type === 'container') {
      const inner = depth + (item.clip === null ? 0 : 1);
      for (const child of item.children) walk(child, inner);
    }
  };
  for (const item of items) walk(item, 0);
  return deepest;
}

export type View = Readonly<{
  camera: RenderCamera;
  devicePixelRatio: number;
  width: number;
  height: number;
}>;

/** World point at the centre of physical pixel (x, y): `camera + pixel / (zoom * dpr)`. */
export function pixelToWorld(view: View, x: number, y: number): readonly [number, number] {
  const scaleFactor = view.camera.zoom * view.devicePixelRatio;
  return [
    view.camera.position.x + (x + 0.5) / scaleFactor,
    view.camera.position.y + (y + 0.5) / scaleFactor,
  ];
}

/** Physical pixel position of a world point. */
export function worldToPixel(view: View, x: number, y: number): readonly [number, number] {
  const scaleFactor = view.camera.zoom * view.devicePixelRatio;
  return [(x - view.camera.position.x) * scaleFactor, (y - view.camera.position.y) * scaleFactor];
}

function windingOf(subpaths: readonly (readonly number[])[], x: number, y: number) {
  let winding = 0;
  let crossings = 0;
  for (const subpath of subpaths) {
    const count = subpath.length / 2;
    for (let index = 0; index < count; index += 1) {
      const x0 = subpath[index * 2]!;
      const y0 = subpath[index * 2 + 1]!;
      const x1 = subpath[((index + 1) % count) * 2]!;
      const y1 = subpath[((index + 1) % count) * 2 + 1]!;
      if (y0 <= y !== y1 <= y) {
        const t = (y - y0) / (y1 - y0);
        if (x0 + t * (x1 - x0) > x) {
          winding += y1 > y0 ? 1 : -1;
          crossings += 1;
        }
      }
    }
  }
  return { winding, crossings };
}

/** True when the local point is in the shape's fill area (a line's is empty). */
export function insideShape(shape: P4Shape, x: number, y: number): boolean {
  switch (shape.kind) {
    case 'rectangle':
      return x >= 0 && x <= shape.width && y >= 0 && y <= shape.height;
    case 'ellipse': {
      const rx = shape.width / 2;
      const ry = shape.height / 2;
      return ((x - rx) / rx) ** 2 + ((y - ry) / ry) ** 2 <= 1;
    }
    case 'line':
      return false;
    case 'path': {
      const { winding, crossings } = windingOf(shape.subpaths, x, y);
      return shape.fillRule === 'nonzero' ? winding !== 0 : crossings % 2 === 1;
    }
  }
}

export type Classification = 'in' | 'out' | 'edge';

/** Offsets sampled around a pixel centre: two rings, radius 1 and 2 physical px. */
const RING: readonly (readonly [number, number])[] = [1, 2].flatMap((radius) =>
  Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * 2 * Math.PI;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  }),
);

/**
 * Classifies a pixel centre against a shape placed by `world`: 'in' or 'out' when every point
 * within 2 physical px agrees, else 'edge'. Sampled on two rings of 48 points (spacing about
 * 0.26 px on the outer ring), so a shape strip thinner than that could pass between samples;
 * the cases keep every shape at least 0.4 px wide.
 */
export function classify(
  view: View,
  shape: P4Shape,
  world: Affine,
  x: number,
  y: number,
): Classification {
  const toLocal = invert(world);
  const scaleFactor = view.camera.zoom * view.devicePixelRatio;
  const test = (dx: number, dy: number) => {
    const wx = view.camera.position.x + (x + 0.5 + dx) / scaleFactor;
    const wy = view.camera.position.y + (y + 0.5 + dy) / scaleFactor;
    const [lx, ly] = transformPoint(toLocal, wx, wy);
    return insideShape(shape, lx, ly);
  };
  const centre = test(0, 0);
  for (const [dx, dy] of RING) if (test(dx, dy) !== centre) return 'edge';
  return centre ? 'in' : 'out';
}

/** A clip level of a leaf's chain: its region as a shape placed in the world. */
export type ClipLevel = Readonly<{
  containerId: string;
  kind: 'rect' | 'mask';
  shape: P4Shape;
  world: Affine;
}>;

/** The clip region of a clipping container, as a placed shape (P4-K1, P4-K2). */
export function levelOf(item: P4Container): ClipLevel | null {
  if (item.clip === null) return null;
  if (item.clip.kind === 'rect') {
    return {
      containerId: item.id,
      kind: 'rect',
      shape: rect(item.clip.width, item.clip.height),
      world: multiply(item.world, translate(item.clip.x, item.clip.y)),
    };
  }
  const source = item.children[0];
  if (source === undefined || source.type !== 'leaf') {
    return { containerId: item.id, kind: 'mask', shape: polygon([]), world: IDENTITY };
  }
  return { containerId: item.id, kind: 'mask', shape: source.shape, world: source.world };
}

export type DrawnLeaf = Readonly<{ leaf: P4Leaf; levels: readonly ClipLevel[] }>;

/** The leaves that paint, in paint order, with their clip chains (P4-K2b, P4-S2). */
export function drawnLeaves(items: readonly P4Item[]): DrawnLeaf[] {
  const drawn: DrawnLeaf[] = [];
  const walk = (item: P4Item, levels: readonly ClipLevel[]) => {
    if (item.visible === false) return;
    const det = item.world[0] * item.world[3] - item.world[1] * item.world[2];
    if (det === 0) return;
    if (item.type === 'leaf') {
      if (item.fill !== null) drawn.push({ leaf: item, levels });
      return;
    }
    const level = levelOf(item);
    const inner = level === null ? levels : [...levels, level];
    item.children.forEach((child, index) => {
      // A mask source is never painted.
      if (item.clip?.kind === 'mask' && index === 0) return;
      walk(child, inner);
    });
  };
  for (const item of items) walk(item, []);
  return drawn;
}

export type OracleOptions = Readonly<{
  /** Applies each leaf's opacity twice (the A05 double-opacity counter-oracle). */
  doubleOpacity?: boolean;
  /** Reverses the paint order (the A05 reordered counter-oracle). */
  reversed?: boolean;
}>;

/**
 * The section 3 colour of an interior pixel as 8-bit RGB, or null when the pixel is near an
 * edge of a shape or clip level that affects it.
 */
export function oracle(
  view: View,
  leaves: readonly DrawnLeaf[],
  x: number,
  y: number,
  options: OracleOptions = {},
): readonly [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  const order = options.reversed === true ? [...leaves].reverse() : leaves;
  for (const { leaf: item, levels } of order) {
    let covered = true;
    for (const level of levels) {
      const state = classify(view, level.shape, level.world, x, y);
      if (state === 'edge') return null;
      if (state === 'out') {
        covered = false;
        break;
      }
    }
    if (!covered) continue;
    const state = classify(view, item.shape, item.world, x, y);
    if (state === 'edge') return null;
    if (state === 'out') continue;
    const opacity = item.opacity ?? 1;
    const alpha = item.fill!.a * opacity * (options.doubleOpacity === true ? opacity : 1);
    r = item.fill!.r * alpha + r * (1 - alpha);
    g = item.fill!.g * alpha + g * (1 - alpha);
    b = item.fill!.b * alpha + b * (1 - alpha);
  }
  return [r * 255, g * 255, b * 255];
}

/** P1's signed rectangle distance at radius 0: negative inside, Euclidean outside. */
function rectangleDistance(x: number, y: number, width: number, height: number): number {
  const qx = Math.abs(x - width / 2) - width / 2;
  const qy = Math.abs(y - height / 2) - height / 2;
  return Math.max(qx, qy) > 0 ? Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) : Math.max(qx, qy);
}

/**
 * P4-K1 at physical pixel (x, y) for a rect level: `clamp(0.5 - d / max(fwidth(d), 1e-6), 0, 1)`
 * with `d` the level's signed rectangle distance at the pixel centre. `fwidth` is evaluated as
 * WGSL allows, over the pixel's 2x2 quad: `coarse` takes both differences at the quad's first
 * pixel, `fine` takes them in the pixel's own row and column.
 */
export function rectCoverage(
  view: View,
  level: ClipLevel,
  x: number,
  y: number,
  derivative: 'coarse' | 'fine',
): number {
  if (level.shape.kind !== 'rectangle') throw new Error('rectCoverage needs a rect level');
  const { width, height } = level.shape;
  const toLocal = invert(level.world);
  const distance = (px: number, py: number) => {
    const [wx, wy] = pixelToWorld(view, px, py);
    const [lx, ly] = transformPoint(toLocal, wx, wy);
    return rectangleDistance(lx, ly, width, height);
  };
  const x0 = x - (x % 2);
  const y0 = y - (y % 2);
  const width2 =
    derivative === 'coarse'
      ? Math.abs(distance(x0 + 1, y0) - distance(x0, y0)) +
        Math.abs(distance(x0, y0 + 1) - distance(x0, y0))
      : Math.abs(distance(x0 + 1, y) - distance(x0, y)) +
        Math.abs(distance(x, y0 + 1) - distance(x, y0));
  return Math.min(1, Math.max(0, 0.5 - distance(x, y) / Math.max(width2, 1e-6)));
}

/**
 * The reference scene of a clip level: its region alone, drawn as an opaque
 * white shape over the black clear. A rect level is a P1 rectangle of the same placement
 * (P4-K1); a mask level is its source's fill draw (P4-K2), so a path source is meshed by the
 * same port into the same mesh.
 */
export function levelReference(level: ClipLevel): P4Item[] | null {
  // A line's fill area is empty (P4-S2); a filled line is not a valid scene, so its reference
  // is an all-black frame, which the caller supplies.
  if (level.shape.kind === 'line') return null;
  return [leaf(`reference-${level.containerId}`, level.shape, level.world, WHITE)];
}

/** All clip levels in a scene, outermost first along each chain, without duplicates. */
export function allLevels(items: readonly P4Item[]): ClipLevel[] {
  const levels = new Map<string, ClipLevel>();
  for (const drawn of drawnLeaves(items)) {
    for (const level of drawn.levels) levels.set(level.containerId, level);
  }
  return [...levels.values()];
}

/** Decodes a base64 RGBA frame. */
export function decodeFrame(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}
