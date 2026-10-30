import type { RenderNodeSnapshot, ScenePaint, ScenePathVerb } from '@vector-studio/contracts';

import {
  dashElementSource,
  dashPath,
  type DashElement,
  type OracleDash,
} from './e24-dash-oracle.js';
import {
  elementSource,
  flattenPath,
  type OracleElement,
  type OracleRegion,
  type OracleShape,
} from './e23-gradient-oracle.js';
import type { LayerTree, LeafSource } from './e25-layer-oracle.js';
import { gate } from './e25-scene.js';
import {
  IDENTITY,
  invert,
  multiply,
  transformPoint,
  translate,
  type Affine,
} from './p4-clip-oracle.js';

// MVP M4 contract, M4-A12 (unit M4-U4): the adapter from a projected scene to the E23, E24 and
// E25 oracles' hand-built inputs. It walks the scene from its root order and builds, for each
// drawn leaf, an E23 `OracleElement` (primitives, and paths whose stroke is solid with a round
// join on closed subpaths, or that have no stroke; cubics flattened by E23's `flattenPath`) or an
// E24 `DashElement` (every other stroked path: dashed, or with a miter or bevel join, or open,
// with its dash path inputs from E24's `dashPath`), under the rect clips and mask sources above
// it (P4); and for each container an E25 `LayerTree` group with its opacity (0 when hidden). A
// frame unit is two containers in the scene (the outer one with the opacity, the content one
// with the rect clip), so it becomes two nested groups. The oracles then evaluate the scene the
// editor projects; nothing is re-derived from the document. A leaf is culled to 'none' outside
// its world bounds grown by its stroke's reach and a margin, which keeps full-frame probing fast
// and changes no decided value.

type Scene = Readonly<{
  nodes: ReadonlyMap<string, RenderNodeSnapshot> | readonly RenderNodeSnapshot[];
  rootOrder: readonly string[];
}>;

type Box = readonly [number, number, number, number];

function nodesOf(scene: Scene): Iterable<RenderNodeSnapshot> {
  const nodes = scene.nodes;
  return 'get' in nodes ? nodes.values() : nodes;
}

/** A shape kind no oracle covers (a rounded primitive rectangle, a stroked primitive ellipse). */
export class UnsupportedSceneNode extends Error {}

function boundsOf(points: readonly number[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let index = 0; index < points.length; index += 2) {
    x0 = Math.min(x0, points[index]!);
    x1 = Math.max(x1, points[index]!);
    y0 = Math.min(y0, points[index + 1]!);
    y1 = Math.max(y1, points[index + 1]!);
  }
  return [x0, y0, x1, y1];
}

/** The world box of a local box grown by `reach` (local units), through `world`. */
function worldBox(world: Affine, box: Box, reach: number): Box {
  const [x0, y0, x1, y1] = [box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach];
  const corners = [
    transformPoint(world, x0, y0),
    transformPoint(world, x1, y0),
    transformPoint(world, x1, y1),
    transformPoint(world, x0, y1),
  ].flat();
  return boundsOf(corners);
}

/** A leaf source that is 'none' outside `box` grown by 4 physical px. */
function culled(box: Box, source: LeafSource): LeafSource {
  return (wx, wy, pixelSize) => {
    const margin = 4 * pixelSize;
    if (
      wx < box[0] - margin ||
      wx > box[2] + margin ||
      wy < box[1] - margin ||
      wy > box[3] + margin
    )
      return 'none';
    return source(wx, wy, pixelSize);
  };
}

/** Each subpath of a path as its flattened polyline, and whether it is closed (E24 polylines). */
function subpaths(
  verbs: readonly ScenePathVerb[],
  points: readonly number[],
): { line: OracleDash; closed: boolean }[] {
  const out: { line: OracleDash; closed: boolean }[] = [];
  let verbsOf: ScenePathVerb[] = [];
  let pointsOf: number[] = [];
  let cursor = 0;
  const flush = (closed: boolean) => {
    if (verbsOf.length === 0) return;
    const [polygon] = flattenPath(verbsOf, pointsOf, 256);
    const line: [number, number][] = [];
    for (let index = 0; index < polygon!.length; index += 2)
      line.push([polygon![index]!, polygon![index + 1]!]);
    if (closed) line.push(line[0]!);
    out.push({ line: { points: line, closed }, closed });
    verbsOf = [];
    pointsOf = [];
  };
  for (const verb of verbs) {
    if (verb === 'move') {
      flush(false);
      verbsOf.push('move');
      pointsOf.push(points[cursor]!, points[cursor + 1]!);
      cursor += 2;
    } else if (verb === 'line') {
      verbsOf.push('line');
      pointsOf.push(points[cursor]!, points[cursor + 1]!);
      cursor += 2;
    } else if (verb === 'cubic') {
      verbsOf.push('cubic');
      pointsOf.push(...points.slice(cursor, cursor + 6));
      cursor += 6;
    } else {
      verbsOf.push('close');
      flush(true);
    }
  }
  flush(false);
  return out;
}

/** The oracle leaf of one drawn scene leaf at `world`, under `under`. */
function leafSource(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' | 'path' }>,
  world: Affine,
  under: readonly OracleRegion[],
): LeafSource {
  const opacity = node.opacity;
  if (node.kind === 'primitive') {
    const geometry = node.geometry;
    const stroke = node.style.stroke;
    let shape: OracleShape;
    let box: Box;
    if (geometry.kind === 'rectangle') {
      if (geometry.cornerRadii.some((radius) => radius !== 0))
        throw new UnsupportedSceneNode(`${node.id}: a rounded primitive rectangle`);
      shape = { kind: 'rectangle', width: geometry.width, height: geometry.height };
      box = [0, 0, geometry.width, geometry.height];
    } else if (geometry.kind === 'ellipse') {
      if (stroke !== null)
        throw new UnsupportedSceneNode(`${node.id}: a stroked primitive ellipse`);
      shape = { kind: 'ellipse', width: geometry.width, height: geometry.height };
      box = [0, 0, geometry.width, geometry.height];
    } else {
      shape = {
        kind: 'line',
        x1: geometry.start.x,
        y1: geometry.start.y,
        x2: geometry.end.x,
        y2: geometry.end.y,
      };
      box = boundsOf([geometry.start.x, geometry.start.y, geometry.end.x, geometry.end.y]);
    }
    const element: OracleElement = {
      world,
      shape,
      fill: node.style.fill,
      stroke: stroke === null ? null : { paint: stroke.color, width: stroke.width },
      opacity,
      under,
    };
    const reach = stroke === null ? 0 : stroke.width;
    return culled(worldBox(world, box, reach), (wx, wy, size) =>
      elementSource(element, wx, wy, size),
    );
  }
  const { verbs, points } = node.geometry;
  const fill: ScenePaint | null = node.style.fill;
  const stroke = node.style.stroke;
  const polygons = flattenPath(verbs, points, 256).filter((polygon) => polygon.length >= 6);
  const parts = subpaths(verbs, points);
  const box = boundsOf(points);
  const reach = stroke === null ? 0 : stroke.width * Math.max(1, stroke.miterLimit / 2, Math.SQRT2);
  const e23 =
    stroke === null ||
    ((stroke.dash ?? null) === null &&
      stroke.join === 'round' &&
      parts.every((part) => part.closed));
  if (e23) {
    const element: OracleElement = {
      world,
      shape: { kind: 'path', polygons },
      fill,
      stroke: stroke === null ? null : { paint: stroke.color, width: stroke.width },
      opacity,
      under,
    };
    return culled(worldBox(world, box, reach), (wx, wy, size) =>
      elementSource(element, wx, wy, size),
    );
  }
  const dash = stroke.dash ?? null;
  const element: DashElement = {
    world,
    fill: fill === null ? null : { paint: fill, polygons },
    stroke: {
      paint: stroke.color,
      width: stroke.width,
      cap: stroke.cap,
      dashes: dash === null ? parts.map((part) => part.line) : dashPath(verbs, points, dash),
    },
    opacity,
  };
  return culled(worldBox(world, box, reach), (wx, wy, size) => {
    const coverage = gate(under, wx, wy, size);
    if (coverage === null) return null;
    if (coverage === 0) return 'none';
    return dashElementSource(element, wx, wy, size);
  });
}

/** A mask source's area region (E23-K5: its paint and opacity do not matter). */
function maskRegion(node: RenderNodeSnapshot, world: Affine): OracleRegion {
  if (node.kind === 'path') {
    const polygons = flattenPath(node.geometry.verbs, node.geometry.points, 256).filter(
      (polygon) => polygon.length >= 6,
    );
    return { world, shape: { kind: 'path', polygons } };
  }
  if (node.kind === 'primitive' && node.geometry.kind !== 'line') {
    if (node.geometry.kind === 'rectangle' && node.geometry.cornerRadii.some((r) => r !== 0))
      throw new UnsupportedSceneNode(`${node.id}: a rounded mask source`);
    return {
      world,
      shape: { kind: node.geometry.kind, width: node.geometry.width, height: node.geometry.height },
    };
  }
  throw new UnsupportedSceneNode(`${node.id}: a mask source of kind ${node.kind}`);
}

/**
 * The E25 layer tree of a projected scene (M4-A12): containers become groups (opacity 0 when
 * hidden), drawn leaves become E23 or E24 element sources under their clips and masks, and
 * hidden leaves and mask sources draw nothing themselves.
 */
export function sceneLayerTree(scene: Scene): LayerTree[] {
  const byId = new Map<string, RenderNodeSnapshot>();
  for (const node of nodesOf(scene)) byId.set(node.id, node);
  const walk = (
    ids: readonly string[],
    parentWorld: Affine,
    under: readonly OracleRegion[],
  ): LayerTree[] => {
    const out: LayerTree[] = [];
    for (const id of ids) {
      const node = byId.get(id);
      if (node === undefined) throw new Error(`The scene has no node ${id}.`);
      const world = multiply(parentWorld, node.transform);
      if (node.kind === 'container') {
        let inner = under;
        let children = node.children;
        if (node.clip?.kind === 'rect') {
          const region: OracleRegion = {
            world: multiply(world, translate(node.clip.x, node.clip.y)),
            shape: { kind: 'rectangle', width: node.clip.width, height: node.clip.height },
          };
          inner = [...under, region];
        } else if (node.clip?.kind === 'mask') {
          const [source, ...rest] = children;
          if (source === undefined) {
            children = [];
          } else {
            const sourceNode = byId.get(source)!;
            inner = [...under, maskRegion(sourceNode, multiply(world, sourceNode.transform))];
            children = rest;
          }
        }
        out.push({
          kind: 'group',
          opacity: node.visible ? node.opacity : 0,
          children: walk(children, world, inner),
        });
        continue;
      }
      if (!node.visible) continue;
      if (node.kind !== 'primitive' && node.kind !== 'path')
        throw new UnsupportedSceneNode(`${node.id}: a ${node.kind} leaf`);
      out.push({ kind: 'leaf', source: leafSource(node, world, under) });
    }
    return out;
  };
  return walk(scene.rootOrder, IDENTITY, []);
}

/** The world affine of scene node `id` (its parent chain composed). */
export function sceneWorld(scene: Scene, id: string): Affine {
  const byId = new Map<string, RenderNodeSnapshot>();
  for (const node of nodesOf(scene)) byId.set(node.id, node);
  let world: Affine = IDENTITY;
  for (
    let at = byId.get(id);
    at !== undefined;
    at = at.parentId === null ? undefined : byId.get(at.parentId)
  )
    world = multiply(at.transform, world);
  return world;
}

/** A local point of scene node `id` in world (page) units. */
export function sceneToWorld(scene: Scene, id: string, x: number, y: number) {
  return transformPoint(sceneWorld(scene, id), x, y);
}

/** A world point in scene node `id`'s local units. */
export function worldToScene(scene: Scene, id: string, x: number, y: number) {
  return transformPoint(invert(sceneWorld(scene, id)), x, y);
}
