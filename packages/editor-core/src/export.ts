import type {
  PathStroke,
  RenderNodeSnapshot,
  SceneAffine,
  SceneBlendMode,
  SceneClip,
  ScenePaint,
  ScenePathGeometry,
  SceneTextRun,
} from '@vector-studio/contracts';
import { isSceneGradient } from '@vector-studio/contracts';
import type { DocumentV8, Frame } from '@vector-studio/model';
import type { ExpansionCache } from './expansion.js';
import { apply, boundsOfPoints, multiply } from './geometry.js';
import {
  ellipseOutline,
  projectPage,
  rectangleOutline,
  type CustomProjection,
} from './projector.js';
import type { TextLayouter } from './text.js';
import { documentTree, isAncestor, pageOf, spaceOf } from './tree.js';
import type { ExportNode, ExportScene } from './types.js';
import { visualBounds } from './visual-bounds.js';

// V-30 export contract (docs/plans/viz-v30-export-contract.md), section 2: the export scene of
// the active page or of some of its nodes, and its SVG text. Pure data and strings, no DOM.

/** Primitive strokes take the SVG and Canvas default miter limit (V30-S3). */
const PRIMITIVE_MITER_LIMIT = 4;

/** What the editor hands the export: its projection inputs. */
export type ExportSource = Readonly<{
  document: DocumentV8;
  pageId: string;
  custom: CustomProjection;
  expansions: ExpansionCache;
  layout: TextLayouter | undefined;
}>;

/** V30-S3: a scene node as an export node, primitives turned into paths. */
function exportNode(node: RenderNodeSnapshot, transform: SceneAffine): ExportNode | null {
  const base = {
    id: node.id,
    transform,
    opacity: node.opacity,
    ...(node.blendMode === undefined ? {} : { blendMode: node.blendMode }),
  };
  switch (node.kind) {
    case 'container':
      return { ...base, kind: 'container', children: node.children, clip: node.clip };
    case 'path':
      return {
        ...base,
        kind: 'path',
        geometry: node.geometry,
        fill: node.style.fill,
        stroke: node.style.stroke,
      };
    case 'text':
      return { ...base, kind: 'text', lang: node.lang, runs: node.runs };
    case 'primitive': {
      const { geometry, style } = node;
      const stroke = (join: PathStroke['join'], cap: PathStroke['cap']): PathStroke | null =>
        style.stroke === null
          ? null
          : {
              color: style.stroke.color,
              width: style.stroke.width,
              cap,
              join,
              miterLimit: PRIMITIVE_MITER_LIMIT,
            };
      switch (geometry.kind) {
        case 'rectangle':
          return {
            ...base,
            kind: 'path',
            geometry: rectangleOutline(geometry.width, geometry.height, geometry.cornerRadii),
            fill: style.fill,
            stroke: stroke('round', 'butt'),
          };
        case 'ellipse':
          return {
            ...base,
            kind: 'path',
            geometry: ellipseOutline(geometry.width, geometry.height),
            fill: style.fill,
            stroke: stroke('round', 'butt'),
          };
        case 'line': {
          const { start, end } = geometry;
          return {
            ...base,
            kind: 'path',
            geometry: {
              kind: 'path',
              verbs: ['move', 'line'],
              points: [start.x, start.y, end.x, end.y],
              fillRule: 'nonzero',
            },
            fill: null,
            stroke: stroke('miter', 'butt'),
          };
        }
      }
    }
  }
  return null;
}

/**
 * V30-S1 to S4: the export scene of `ids` (or the page's top-level nodes) on `source.pageId`, or
 * null when nothing is left to draw.
 */
export function buildExportScene(
  source: ExportSource,
  ids: readonly string[] | undefined,
): ExportScene | null {
  const { document, pageId } = source;
  const tree = documentTree(document);
  const page = tree.page(pageId);
  if (page === undefined) return null;
  const projection = projectPage(
    document,
    pageId,
    source.custom,
    new Set(),
    undefined,
    source.expansions,
    undefined,
    source.layout,
    // V35-E1: export carries the blend modes whatever the host's renderer draws.
    false,
    true,
  );
  // Paint order is document pre-order over the projected units (V30-S2).
  const order = new Map(projection.units.map((id, index) => [id, index]));
  const asked = ids === undefined ? page.children : ids;
  const candidates = [
    ...new Set(
      asked.filter(
        (id) =>
          typeof id === 'string' && tree.node(id) !== undefined && pageOf(tree, id) === pageId,
      ),
    ),
  ];
  // Hidden and unprojected IDs go first, so a visible child of a hidden selected group stays.
  const drawable = candidates.filter(
    (id) => tree.node(id)!.visible && order.has(id) && projection.nodes.has(id),
  );
  const roots = drawable
    .filter((id) => !drawable.some((other) => other !== id && isAncestor(tree, other, id)))
    .sort((a, b) => order.get(a)! - order.get(b)!);
  if (roots.length === 0) return null;

  const nodes = new Map<string, ExportNode>();
  // A mask source is kept whatever its visibility (P4-Q3): it is never painted, only clips.
  const add = (id: string, transform: SceneAffine, maskSource = false): void => {
    const snapshot = projection.nodes.get(id);
    if (snapshot === undefined || (!snapshot.visible && !maskSource) || nodes.has(id)) return;
    const node = exportNode(snapshot, transform);
    if (node === null) return;
    nodes.set(id, node);
    if (node.kind === 'container') {
      node.children.forEach((child, index) => {
        const scene = projection.nodes.get(child);
        if (scene !== undefined) {
          add(child, scene.transform, index === 0 && node.clip?.kind === 'mask');
        }
      });
    }
  };

  let box: Frame | null = null;
  const rootOrder: string[] = [];
  for (const id of roots) {
    const node = tree.node(id)!;
    const parent = spaceOf(tree, node.parent).matrix;
    const snapshot = projection.nodes.get(id)!;
    add(id, multiply(parent, snapshot.transform));
    if (!nodes.has(id)) continue;
    rootOrder.push(id);
    const local = visualBounds(document, node);
    const mapped = boundsOfPoints([
      apply(parent, local.x, local.y),
      apply(parent, local.x + local.width, local.y),
      apply(parent, local.x + local.width, local.y + local.height),
      apply(parent, local.x, local.y + local.height),
    ])!;
    box =
      box === null
        ? mapped
        : boundsOfPoints([
            { x: box.x, y: box.y },
            { x: box.x + box.width, y: box.y + box.height },
            { x: mapped.x, y: mapped.y },
            { x: mapped.x + mapped.width, y: mapped.y + mapped.height },
          ])!;
  }
  if (box === null || rootOrder.length === 0) return null;
  // V30-S4: whole page units, outward, at least 1 × 1.
  const x = Math.floor(box.x);
  const y = Math.floor(box.y);
  const width = Math.max(1, Math.ceil(box.x + box.width) - x);
  const height = Math.max(1, Math.ceil(box.y + box.height) - y);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { bounds: { x, y, width, height }, nodes, rootOrder };
}

// --- SVG (V30-S5) ---

/** At most 4 decimals, no trailing zeros, no negative zero. */
export function svgNumber(value: number): string {
  if (!(Math.abs(value) < 1e15)) return String(value);
  const rounded = Math.round(value * 10_000) / 10_000;
  return String(rounded === 0 ? 0 : rounded);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML 1.0 forbids most C0 controls even as references; they are left out of text. */
function xmlText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return escapeXml(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ''));
}

function matrixAttribute(m: SceneAffine): string {
  if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0) return '';
  return ` transform="matrix(${m.map(svgNumber).join(' ')})"`;
}

/** The `d` attribute of a path geometry. */
export function svgPathData(geometry: ScenePathGeometry): string {
  const parts: string[] = [];
  let at = 0;
  const p = geometry.points;
  const pair = (i: number) => `${svgNumber(p[i]!)} ${svgNumber(p[i + 1]!)}`;
  for (const verb of geometry.verbs) {
    switch (verb) {
      case 'move':
        parts.push(`M${pair(at)}`);
        at += 2;
        break;
      case 'line':
        parts.push(`L${pair(at)}`);
        at += 2;
        break;
      case 'cubic':
        parts.push(`C${pair(at)} ${pair(at + 2)} ${pair(at + 4)}`);
        at += 6;
        break;
      case 'close':
        parts.push('Z');
        break;
    }
  }
  return parts.join('');
}

function hexChannel(value: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
  return byte.toString(16).padStart(2, '0');
}

function hexColor(color: { r: number; g: number; b: number }): string {
  return `#${hexChannel(color.r)}${hexChannel(color.g)}${hexChannel(color.b)}`;
}

class SvgWriter {
  private readonly defs: string[] = [];
  private next = 0;

  constructor(private readonly scene: ExportScene) {}

  private id(prefix: string): string {
    this.next += 1;
    return `${prefix}${this.next}`;
  }

  /** ` fill="…"` (and opacity) for `paint` on attribute `name` ('fill' or 'stroke'). */
  private paint(name: 'fill' | 'stroke', paint: ScenePaint | null): string {
    if (paint === null) return ` ${name}="none"`;
    if (!isSceneGradient(paint)) {
      const alpha = Math.min(1, Math.max(0, paint.a));
      return alpha >= 1
        ? ` ${name}="${hexColor(paint)}"`
        : ` ${name}="${hexColor(paint)}" ${name}-opacity="${svgNumber(alpha)}"`;
    }
    const id = this.id('g');
    const stops = paint.stops
      .map((stop) => {
        const alpha = Math.min(1, Math.max(0, stop.color.a));
        const opacity = alpha >= 1 ? '' : ` stop-opacity="${svgNumber(alpha)}"`;
        return `<stop offset="${svgNumber(stop.offset)}" stop-color="${hexColor(stop.color)}"${opacity}/>`;
      })
      .join('');
    const common = `id="${id}" gradientUnits="userSpaceOnUse" gradientTransform="matrix(${paint.transform
      .map(svgNumber)
      .join(' ')})" spreadMethod="${paint.spread}"`;
    this.defs.push(
      paint.kind === 'linear'
        ? `<linearGradient ${common} x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient>`
        : `<radialGradient ${common} cx="0" cy="0" r="1" fx="0" fy="0">${stops}</radialGradient>`,
    );
    return ` ${name}="url(#${id})"`;
  }

  private opacity(node: ExportNode): string {
    return node.opacity < 1 ? ` opacity="${svgNumber(node.opacity)}"` : '';
  }

  /**
   * V35-E2: `mix-blend-mode` for a mode other than `normal`, and `isolation: isolate` on a
   * container that is an isolated layer (any mode but `passThrough`).
   */
  private blend(node: ExportNode): string {
    const mode = node.blendMode;
    if (mode === undefined || mode === 'passThrough') return '';
    const parts: string[] = [];
    if (mode !== 'normal') parts.push(`mix-blend-mode: ${cssBlendMode(mode)}`);
    if (node.kind === 'container') parts.push('isolation: isolate');
    return parts.length === 0 ? '' : ` style="${parts.join('; ')}"`;
  }

  /** The `clip-path` attribute of a container, or null when the clip covers nothing. */
  private clip(clip: SceneClip, children: readonly string[]): string | null {
    if (clip === null) return '';
    const id = this.id('c');
    if (clip.kind === 'rect') {
      this.defs.push(
        `<clipPath id="${id}"><rect x="${svgNumber(clip.x)}" y="${svgNumber(clip.y)}" width="${svgNumber(clip.width)}" height="${svgNumber(clip.height)}"/></clipPath>`,
      );
      return ` clip-path="url(#${id})"`;
    }
    // P4-S2: the source's fill area under its fill rule; its style, opacity and visibility
    // do not matter. A source left out of the scene (hidden) is still the mask.
    const source = children[0] === undefined ? undefined : this.scene.nodes.get(children[0]);
    if (source?.kind !== 'path') return null;
    this.defs.push(
      `<clipPath id="${id}"><path${matrixAttribute(source.transform)} d="${svgPathData(source.geometry)}" clip-rule="${source.geometry.fillRule}"/></clipPath>`,
    );
    return ` clip-path="url(#${id})"`;
  }

  private stroke(stroke: PathStroke | null): string {
    if (stroke === null || !(stroke.width > 0)) return ' stroke="none"';
    let out = this.paint('stroke', stroke.color);
    out += ` stroke-width="${svgNumber(stroke.width)}"`;
    out += ` stroke-linecap="${stroke.cap}" stroke-linejoin="${stroke.join}"`;
    out += ` stroke-miterlimit="${svgNumber(stroke.miterLimit)}"`;
    const dash = stroke.dash;
    if (dash !== undefined && dash !== null && dash.pattern.length > 0) {
      out += ` stroke-dasharray="${dash.pattern.map(svgNumber).join(' ')}"`;
      if (dash.phase !== 0) out += ` stroke-dashoffset="${svgNumber(dash.phase)}"`;
    }
    return out;
  }

  private text(runs: readonly SceneTextRun[]): string {
    return runs
      .map((run) => {
        const spans = run.clusters
          .map(
            (cluster) =>
              `<tspan x="${svgNumber(cluster.x)}" y="${svgNumber(cluster.y)}">${xmlText(cluster.text)}</tspan>`,
          )
          .join('');
        return `<text font-family="${escapeXml(run.fontList)}" font-size="${svgNumber(run.size)}"${this.paint('fill', run.color)}>${spans}</text>`;
      })
      .join('');
  }

  node(id: string): string {
    const node = this.scene.nodes.get(id);
    if (node === undefined || !(node.opacity > 0)) return '';
    const head = `${matrixAttribute(node.transform)}${this.opacity(node)}${this.blend(node)}`;
    switch (node.kind) {
      case 'container': {
        const clip = this.clip(node.clip, node.children);
        if (clip === null) return '';
        const children = node.clip?.kind === 'mask' ? node.children.slice(1) : node.children;
        const body = children.map((child) => this.node(child)).join('');
        return body === '' ? '' : `<g${head}${clip}>${body}</g>`;
      }
      case 'path': {
        const fill = this.paint('fill', node.fill);
        const rule =
          node.fill !== null && node.geometry.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
        return `<path${head} d="${svgPathData(node.geometry)}"${fill}${rule}${this.stroke(node.stroke)}/>`;
      }
      case 'text': {
        const body = this.text(node.runs);
        return body === ''
          ? ''
          : `<g${head} xml:space="preserve" xml:lang="${escapeXml(node.lang)}">${body}</g>`;
      }
    }
  }

  write(): string {
    const { x, y, width, height } = this.scene.bounds;
    const body = this.scene.rootOrder.map((id) => this.node(id)).join('');
    const defs = this.defs.length === 0 ? '' : `<defs>${this.defs.join('')}</defs>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">` +
      `${defs}${body}</svg>\n`
    );
  }
}

/** The CSS name of a blend mode: `colorDodge` → `color-dodge` (V35-E2). */
export function cssBlendMode(mode: SceneBlendMode): string {
  return mode.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** V30-S5: the SVG text of an export scene. */
export function exportSceneToSvg(scene: ExportScene): string {
  return new SvgWriter(scene).write();
}
