import type {
  PathStroke,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneClip,
  SceneColor,
  SceneDash,
  ScenePaint,
  ScenePathVerb,
} from '@vector-studio/contracts';

import { dashElementSource, dashPath, type OracleDash } from './e24-dash-oracle.js';
import {
  elementSource,
  flattenPath,
  type OracleElement,
  type OracleRegion,
  type OracleShape,
  type Premultiplied,
} from './e23-gradient-oracle.js';
import type { LayerTree, LeafSource } from './e25-layer-oracle.js';
import { IDENTITY, multiply, translate, type Affine } from './p4-clip-oracle.js';

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U4: the scene builder of
// tests/gpu/e25-isolated-opacity.spec.ts, moved here unchanged for E28 U4, which adds text
// leaves through `custom`. It builds render nodes and their oracle tree side by side.

const WHITE: SceneColor = { r: 1, g: 1, b: 1, a: 1 };

/**
 * An oracle leaf. `drop` names one region (an axis-aligned rect clip whose edge an edge probe
 * sits on): a leaf under it is evaluated without it and scaled by `factor`, the clip's coverage
 * on its edge (E25-K2: per leaf, inside the layer).
 */
export type BuiltNode =
  | Readonly<{
      kind: 'leaf';
      under: readonly OracleRegion[];
      source: (under: readonly OracleRegion[]) => LeafSource;
    }>
  | Readonly<{ kind: 'group'; opacity: number; children: BuiltNode[] }>;

export type Ctx = Readonly<{
  parent: string | null;
  world: Affine;
  under: readonly OracleRegion[];
  out: BuiltNode[];
  ids: string[];
}>;

export type PathSpec = Readonly<{
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
  fill: ScenePaint | null;
  stroke: Readonly<{ paint: ScenePaint; width: number; dash?: SceneDash }> | null;
  opacity?: number;
}>;

export const scaled = (value: Premultiplied, factor: number): Premultiplied =>
  value.map((lane) => lane * factor) as unknown as Premultiplied;

/** The product of `regions`' coverages at a point: 1, 'none' (0), or null near a boundary. */
export function gate(regions: readonly OracleRegion[], wx: number, wy: number, pixelSize: number) {
  if (regions.length === 0) return 1;
  const [first, ...rest] = regions;
  const probe: OracleElement = {
    world: first!.world,
    shape: first!.shape,
    fill: WHITE,
    stroke: null,
    opacity: 1,
    under: rest,
  };
  const value = elementSource(probe, wx, wy, pixelSize);
  return value === null ? null : value === 'none' ? 0 : 1;
}

export class Scene {
  readonly nodes: RenderNodeSnapshot[] = [];
  readonly roots: string[] = [];
  readonly built: BuiltNode[] = [];

  root(): Ctx {
    return { parent: null, world: IDENTITY, under: [], out: this.built, ids: this.roots };
  }

  constructor(readonly documentId = 'e25-u4') {}

  #leaf(ctx: Ctx, node: RenderNodeSnapshot, source: BuiltNode) {
    this.nodes.push(node);
    ctx.ids.push(node.id);
    ctx.out.push(source);
  }

  /** A rectangle or ellipse primitive with a fill. */
  shape(
    ctx: Ctx,
    id: string,
    transform: Affine,
    geometry:
      | Readonly<{ kind: 'rectangle'; width: number; height: number }>
      | Readonly<{ kind: 'ellipse'; width: number; height: number }>,
    fill: ScenePaint,
    opacity = 1,
  ) {
    const world = multiply(ctx.world, transform);
    const element = (under: readonly OracleRegion[]): OracleElement => ({
      world,
      shape: geometry,
      fill,
      stroke: null,
      opacity,
      under,
    });
    this.#leaf(
      ctx,
      {
        id,
        parentId: ctx.parent,
        transform,
        visible: true,
        opacity,
        kind: 'primitive',
        geometry:
          geometry.kind === 'rectangle'
            ? { ...geometry, cornerRadii: [0, 0, 0, 0] as const }
            : { kind: 'ellipse' as const, width: geometry.width, height: geometry.height },
        style: { fill, stroke: null },
      },
      {
        kind: 'leaf',
        under: ctx.under,
        source: (under) => (wx, wy, size) => elementSource(element(under), wx, wy, size),
      },
    );
  }

  /** A path; closed solid strokes use the E23 oracle (round joins), dashed ones E24's. */
  path(ctx: Ctx, id: string, transform: Affine, spec: PathSpec) {
    const world = multiply(ctx.world, transform);
    const opacity = spec.opacity ?? 1;
    const stroke: PathStroke | null =
      spec.stroke === null
        ? null
        : {
            color: spec.stroke.paint,
            width: spec.stroke.width,
            cap: 'butt',
            join: 'round',
            miterLimit: 4,
            dash: spec.stroke.dash ?? null,
          };
    const polygons = flattenPath(spec.verbs, spec.points, 256).filter(
      (polygon) => polygon.length >= 6,
    );
    let source: (under: readonly OracleRegion[]) => LeafSource;
    if (spec.stroke?.dash !== undefined) {
      const dashes: OracleDash[] = dashPath(spec.verbs, spec.points, spec.stroke.dash);
      const element = {
        world,
        fill: spec.fill === null ? null : { paint: spec.fill, polygons },
        stroke: {
          paint: spec.stroke.paint,
          width: spec.stroke.width,
          cap: 'butt' as const,
          dashes,
        },
        opacity,
      };
      source = (under) => (wx, wy, size) => {
        const coverage = gate(under, wx, wy, size);
        if (coverage === null) return null;
        if (coverage === 0) return 'none';
        return dashElementSource(element, wx, wy, size);
      };
    } else {
      const shape: OracleShape = { kind: 'path', polygons };
      source = (under) => (wx, wy, size) =>
        elementSource(
          {
            world,
            shape,
            fill: spec.fill,
            stroke:
              spec.stroke === null ? null : { paint: spec.stroke.paint, width: spec.stroke.width },
            opacity,
            under,
          },
          wx,
          wy,
          size,
        );
    }
    this.#leaf(
      ctx,
      {
        id,
        parentId: ctx.parent,
        transform,
        visible: true,
        opacity,
        kind: 'path',
        geometry: { kind: 'path', verbs: spec.verbs, points: spec.points, fillRule: 'evenodd' },
        style: { fill: spec.fill, stroke },
      },
      { kind: 'leaf', under: ctx.under, source },
    );
  }

  /**
   * A container. A rect clip adds its region to the children's `under`; for a mask, `build`
   * calls `maskSource` first. Returns the clip region, if any.
   */
  group(
    ctx: Ctx,
    id: string,
    transform: Affine,
    opacity: number,
    clip: SceneClip | null,
    build: (inner: Ctx) => void,
    visible = true,
  ): OracleRegion | null {
    const world = multiply(ctx.world, transform);
    const region: OracleRegion | null =
      clip?.kind === 'rect'
        ? {
            world: multiply(world, translate(clip.x, clip.y)),
            shape: { kind: 'rectangle', width: clip.width, height: clip.height },
          }
        : null;
    const children: string[] = [];
    const node = {
      id,
      parentId: ctx.parent,
      transform,
      visible,
      opacity,
      kind: 'container' as const,
      clip,
      children,
    };
    this.nodes.push(node);
    ctx.ids.push(id);
    const built: BuiltNode = { kind: 'group', opacity: visible ? opacity : 0, children: [] };
    ctx.out.push(built);
    build({
      parent: id,
      world,
      under: region === null ? ctx.under : [...ctx.under, region],
      out: built.children,
      ids: children,
    });
    return region;
  }

  /** A mask container's first child: drawn as the mask only. Returns the children's context. */
  maskSource(ctx: Ctx, id: string, transform: Affine, spec: PathSpec): Ctx {
    const polygons = flattenPath(spec.verbs, spec.points, 256).filter(
      (polygon) => polygon.length >= 6,
    );
    this.nodes.push({
      id,
      parentId: ctx.parent,
      transform,
      visible: true,
      opacity: 1,
      kind: 'path',
      geometry: { kind: 'path', verbs: spec.verbs, points: spec.points, fillRule: 'evenodd' },
      style: { fill: WHITE, stroke: null },
    });
    ctx.ids.push(id);
    const region: OracleRegion = {
      world: multiply(ctx.world, transform),
      shape: { kind: 'path', polygons },
    };
    return { ...ctx, under: [...ctx.under, region] };
  }

  /** A leaf of another kind (E28 U4: text) with its oracle source under the context's regions. */
  custom(
    ctx: Ctx,
    node: RenderNodeSnapshot,
    source: (under: readonly OracleRegion[]) => LeafSource,
  ) {
    this.#leaf(ctx, node, { kind: 'leaf', under: ctx.under, source });
  }

  snapshot(): RenderSceneSnapshot {
    return {
      identity: { documentId: this.documentId, pageId: 'page' },
      revision: 1,
      nodes: this.nodes,
      rootOrder: this.roots,
    };
  }

  /** The oracle tree; with `drop`, leaves under it ignore it and are scaled by `factor`. */
  tree(drop: OracleRegion | null = null, factor = 0.5): LayerTree[] {
    const convert = (nodes: readonly BuiltNode[]): LayerTree[] =>
      nodes.map((node): LayerTree => {
        if (node.kind === 'group')
          return { kind: 'group', opacity: node.opacity, children: convert(node.children) };
        if (drop === null || !node.under.includes(drop))
          return { kind: 'leaf', source: node.source(node.under) };
        const inner = node.source(node.under.filter((region) => region !== drop));
        return {
          kind: 'leaf',
          source: (wx, wy, size) => {
            const value = inner(wx, wy, size);
            return value === null || value === 'none' ? value : scaled(value, factor);
          },
        };
      });
    return convert(this.built);
  }
}

export const rect = (width: number, height: number) => ({
  kind: 'rectangle' as const,
  width,
  height,
});
export const ellipse = (width: number, height: number) => ({
  kind: 'ellipse' as const,
  width,
  height,
});

/** A closed polygon path (`move`, `line`s, `close`) for each ring. */
export function rings(...polygons: readonly (readonly number[])[]) {
  const verbs: ScenePathVerb[] = [];
  const points: number[] = [];
  for (const polygon of polygons) {
    verbs.push('move');
    for (let index = 2; index < polygon.length; index += 2) verbs.push('line');
    verbs.push('close');
    points.push(...polygon);
  }
  return { verbs, points };
}

export const square = (x0: number, y0: number, x1: number, y1: number) => [
  x0,
  y0,
  x1,
  y0,
  x1,
  y1,
  x0,
  y1,
];
