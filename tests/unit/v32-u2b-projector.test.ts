// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U2b: the projection of image fills
// (V32-A04: M5 scale modes, S4 gate and notice, zero size), fill opacity, mask sources, and the SVG
// export of image paints (V32-A07, SVG half).
import type { RenderNodeSnapshot, ScenePaint } from '@vector-studio/contracts';
import { validateDocument, type DocumentV8, type ImageScaleMode } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';
import {
  composePaint,
  frameBackgroundId,
  projectNode,
  projectPage,
  type PageProjection,
} from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';
import { entry, makeAsset } from '../support/v32-images.js';

type Json = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' };
const a = makeAsset(1, 64, 32);
const TABLE = { [a.key]: entry(a) };
const red = { r: 1, g: 0, b: 0, a: 1 };

const imagePaint = (scaleMode: ImageScaleMode, scale = 1) => ({
  kind: 'image',
  image: a.key,
  scaleMode,
  scale,
});
const fill = (paint: unknown, extra: Json = {}) => ({
  paint,
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  ...extra,
});

function node(id: string, parent: string, type: string, extra: Json = {}): Json {
  const container = ['group', 'maskGroup', 'frame', 'symbol', 'instance'].includes(type);
  return {
    id,
    name: id,
    parent,
    frame: { x: 10, y: 10, width: 100, height: 80 },
    rotation: 30,
    constraints: START,
    opacity: 1,
    visible: true,
    type,
    ...(type === 'rectangle' ? { cornerRadii: [0, 0, 0, 0] } : {}),
    ...(['rectangle', 'ellipse', 'path', 'frame'].includes(type)
      ? { fills: [fill(imagePaint('fill'))], stroke: null }
      : {}),
    ...(['group', 'maskGroup', 'frame', 'symbol'].includes(type) ? { children: [] } : {}),
    blendMode: container ? 'passThrough' : 'normal',
    effects: [],
    ...extra,
  };
}

function doc(nodes: Json[], images: unknown = TABLE): DocumentV8 {
  const value = {
    schemaVersion: 8,
    id: 'd',
    pages: [
      {
        id: 'p',
        name: 'P',
        children: nodes.filter((n) => n.parent === 'p').map((n) => n.id as string),
      },
    ],
    nodes: Object.fromEntries(nodes.map((n) => [n.id as string, n] as const)),
    ...(images === undefined ? {} : { images }),
  };
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

const none = () => null;

function project(document: DocumentV8, images: boolean): PageProjection {
  return projectPage(
    document,
    'p',
    none,
    new Set(),
    undefined,
    new ExpansionCache(),
    undefined,
    undefined,
    false,
    true,
    images,
  );
}

const at = (projection: PageProjection, id: string): RenderNodeSnapshot => {
  const found = projection.nodes.get(id);
  if (found === undefined) throw new Error(`not projected: ${JSON.stringify(id)}`);
  return found;
};

const styleFill = (snapshot: RenderNodeSnapshot): ScenePaint | null | undefined =>
  snapshot.kind === 'primitive' || snapshot.kind === 'path' ? snapshot.style.fill : undefined;

/** The scene image paint of a 64 × 32 image under `mode` in a `w × h` rotated rectangle. */
function paintIn(mode: ImageScaleMode, w: number, h: number, scale = 1) {
  const document = doc([
    node('r', 'p', 'rectangle', {
      frame: { x: 10, y: 10, width: w, height: h },
      fills: [fill(imagePaint(mode, scale))],
    }),
  ]);
  return styleFill(at(project(document, true), 'r'));
}

const image = (transform: number[], wrapX: string, wrapY: string) => ({
  kind: 'image',
  image: a.key,
  transform,
  wrapX,
  wrapY,
});

describe('V32-A04 the four scale modes (V32-M5, S4)', () => {
  it('stretch maps the image onto the box, extending on both axes', () => {
    expect(paintIn('stretch', 100, 80)).toEqual(image([100, 0, 0, 80, 0, 0], 'extend', 'extend'));
  });

  it('fill scales by the larger ratio and centres, cropping the overflow', () => {
    // max(100/64, 80/32) = 2.5: the image is 160 × 80, 30 left of the box on each side.
    expect(paintIn('fill', 100, 80)).toEqual(image([160, 0, 0, 80, -30, 0], 'extend', 'extend'));
  });

  it('fit scales by the smaller ratio and centres, decaling the letterboxed axis', () => {
    // min(1.5625, 2.5): 100 × 50, 15 below the top; y is letterboxed.
    expect(paintIn('fit', 100, 80)).toEqual(image([100, 0, 0, 50, 0, 15], 'extend', 'decal'));
    // A tall box letterboxes y; a wide one letterboxes x.
    expect(paintIn('fit', 40, 80)).toEqual(image([40, 0, 0, 20, 0, 30], 'extend', 'decal'));
    expect(paintIn('fit', 200, 20)).toEqual(image([40, 0, 0, 20, 80, 0], 'decal', 'extend'));
    // The same aspect covers both axes.
    expect(paintIn('fit', 128, 64)).toEqual(image([128, 0, 0, 64, 0, 0], 'extend', 'extend'));
  });

  it('tile repeats the image at its size times the scale from the top-left', () => {
    expect(paintIn('tile', 100, 80, 0.5)).toEqual(image([32, 0, 0, 16, 0, 0], 'repeat', 'repeat'));
    expect(paintIn('tile', 100, 80, 2)).toEqual(image([128, 0, 0, 64, 0, 0], 'repeat', 'repeat'));
  });

  it("does not depend on the node's rotation: the paint is in node-local space", () => {
    const rotated = (rotation: number) =>
      styleFill(
        at(
          project(
            doc([node('r', 'p', 'rectangle', { rotation, fills: [fill(imagePaint('fit'))] })]),
            true,
          ),
          'r',
        ),
      );
    expect(rotated(0)).toEqual(rotated(30));
    expect(rotated(217)).toEqual(rotated(30));
  });

  it('projects a zero-size axis as no fill', () => {
    expect(paintIn('fill', 0, 80)).toBeNull();
    expect(paintIn('tile', 100, 0)).toBeNull();
    expect(paintIn('stretch', 0, 0)).toBeNull();
  });

  it('composePaint resolves through the table and gives null for the rest', () => {
    const paint = { kind: 'image', image: a.key, scaleMode: 'stretch', scale: 1 } as const;
    expect(composePaint(paint, 10, 10, TABLE)).toMatchObject({ kind: 'image' });
    expect(composePaint(paint, 10, 10, null)).toBeNull();
    expect(composePaint(paint, 10, 10, {})).toBeNull();
    expect(composePaint(red, 10, 10)).toEqual(red);
  });

  it('works on ellipses, paths, frames and every fill of a node', () => {
    const projection = project(
      doc([
        node('e', 'p', 'ellipse'),
        node('f', 'p', 'frame', { fills: [fill(red), fill(imagePaint('tile', 0.25))] }),
      ]),
      true,
    );
    expect(styleFill(at(projection, 'e'))).toMatchObject({ kind: 'image' });
    const background = at(projection, `${frameBackgroundId('f')}1`);
    expect(styleFill(background)).toEqual(image([16, 0, 0, 8, 0, 0], 'repeat', 'repeat'));
  });
});

describe('V32-S4 without the option an image fill is no fill, with a notice', () => {
  it('projects fill: null for the node and nothing for the scene mirror to reject', () => {
    const projection = project(doc([node('r', 'p', 'rectangle')]), false);
    expect(styleFill(at(projection, 'r'))).toBeNull();
  });

  const events = (document: DocumentV8, options: Json = {}) => {
    const target = createEditor({
      document,
      ids: createCounterIdSource('n'),
      ...options,
    });
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    const renderer = new RecordingRenderer('supported', {
      paints: options.projectImages === true ? 'image' : 'gradient',
    } as never);
    target.attachRenderer(renderer);
    return { target, seen, renderer };
  };
  const unsupported = (nodeIds: string[]) => ({
    type: 'diagnostic',
    code: 'editor.renderer-unsupported',
    reason: 'unsupported-feature',
    nodeIds,
  });
  const diagnostics = (seen: EditorEvent[]) => seen.filter((event) => event.type === 'diagnostic');

  it('raises editor.renderer-unsupported once per attachment and page', () => {
    const document = doc([
      node('b', 'p', 'rectangle'),
      node('a', 'p', 'ellipse'),
      node('plain', 'p', 'rectangle', { fills: [fill(red)] }),
    ]);
    const { target, seen, renderer } = events(document);
    expect(diagnostics(seen)).toEqual([unsupported(['a', 'b'])]);
    // Later changes, even to image nodes, raise nothing more.
    target.execute({ type: 'setNodeProps', id: 'a', props: { name: 'x' } });
    target.execute({ type: 'createRectangle', frame: { x: 0, y: 0, width: 5, height: 5 } });
    expect(diagnostics(seen)).toHaveLength(1);
    // The scene held no image paint.
    for (const call of renderer.calls) expect(JSON.stringify(call.input)).not.toContain('"image"');
    // A load starts a new report.
    target.execute({ type: 'loadDocument', document });
    expect(diagnostics(seen)).toHaveLength(2);
  });

  it('raises it at the first image fill that appears, and not for hidden or colour fills', () => {
    const document = doc([node('plain', 'p', 'rectangle', { fills: [fill(red)] })], undefined);
    const { target, seen } = events(document);
    expect(diagnostics(seen)).toEqual([]);
    const [id] = (() => {
      const result = target.execute({ type: 'insertImages', assets: [a], at: { x: 0, y: 0 } });
      return result.ok ? result.ids : [];
    })();
    expect(diagnostics(seen)).toEqual([unsupported([id!])]);
  });

  it('is silent with projectImages, and the scene carries the image paint', () => {
    const { seen, renderer } = events(doc([node('r', 'p', 'rectangle')]), { projectImages: true });
    expect(diagnostics(seen)).toEqual([]);
    const sent = renderer.calls.find((call) => call.method === 'replaceSnapshot');
    expect(JSON.stringify(sent?.input)).toContain('"kind":"image"');
  });
});

describe('fill opacity of an image fill (the scene paint has no alpha)', () => {
  it('an image fill below full opacity draws as a leaf of its own with that opacity', () => {
    const projection = project(
      doc([node('r', 'p', 'rectangle', { fills: [fill(imagePaint('fill'), { opacity: 0.5 })] })]),
      true,
    );
    const ids = projection.unitIds.get('r')!;
    expect(ids).toHaveLength(2);
    const leaf = at(projection, ids[1]!);
    expect(leaf.opacity).toBe(0.5);
    expect(styleFill(leaf)).toMatchObject({ kind: 'image' });
    // The container keeps the node's own opacity.
    expect(at(projection, 'r').opacity).toBe(1);
    // A colour fill's opacity is still folded into its alpha.
    const solid = project(
      doc([node('c', 'p', 'rectangle', { fills: [fill(red, { opacity: 0.5 })] })]),
      true,
    );
    expect(styleFill(at(solid, 'c'))).toEqual({ ...red, a: 0.5 });
  });

  it('a frame background and a multi-fill leaf take the fill opacity as theirs', () => {
    const projection = project(
      doc([
        node('f', 'p', 'frame', { fills: [fill(imagePaint('fill'), { opacity: 0.25 })] }),
        node('m', 'p', 'rectangle', {
          fills: [fill(red), fill(imagePaint('fit'), { opacity: 0.75 })],
        }),
      ]),
      true,
    );
    expect(at(projection, frameBackgroundId('f')).opacity).toBe(0.25);
    const [, first, second] = projection.unitIds.get('m')!;
    expect(at(projection, first!).opacity).toBe(1);
    expect(at(projection, second!).opacity).toBe(0.75);
  });

  it('a full-opacity image fill stays one leaf', () => {
    const projection = project(doc([node('r', 'p', 'rectangle')]), true);
    expect(projection.unitIds.get('r')).toEqual(['r']);
  });
});

describe('an image fill of a mask source', () => {
  it('covers its fill area without requesting the image', () => {
    const projection = project(
      doc([
        node('g', 'p', 'maskGroup', { children: ['s', 'c'], rotation: 0 }),
        node('s', 'g', 'path', {
          path: {
            verbs: ['move', 'line', 'line', 'close'],
            points: [0, 0, 1, 0, 1, 1],
            fillRule: 'nonzero',
          },
        }),
        node('c', 'g', 'rectangle', { fills: [fill(red)] }),
      ]),
      true,
    );
    expect(styleFill(at(projection, 's'))).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    // Without the option too: nothing of the source's paint is an image.
    const off = project(
      doc([
        node('g', 'p', 'maskGroup', { children: ['s', 'c'], rotation: 0 }),
        node('s', 'g', 'path', {
          path: {
            verbs: ['move', 'line', 'line', 'close'],
            points: [0, 0, 1, 0, 1, 1],
            fillRule: 'nonzero',
          },
        }),
        node('c', 'g', 'rectangle', { fills: [fill(red)] }),
      ]),
      false,
    );
    expect(styleFill(at(off, 's'))).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });
});

describe('projectNode takes the images argument', () => {
  it('projects one image leaf with the table, none without', () => {
    const document = doc([node('r', 'p', 'rectangle')]);
    const leaf = document.nodes.r!;
    expect(styleFill(projectNode(leaf, none, null, undefined, false, false, TABLE)!)).toMatchObject(
      {
        kind: 'image',
      },
    );
    expect(styleFill(projectNode(leaf, none)!)).toBeNull();
  });
});

describe('V32-A07 SVG export of image paints', () => {
  const href = `data:image/png;base64,${a.data}`;

  function svgOf(paints: unknown, extra: Json = {}): string {
    const target = createEditor({
      document: doc(
        [
          node('r', 'p', 'rectangle', {
            frame: { x: 0, y: 0, width: 100, height: 80 },
            rotation: 0,
            fills: [fill(paints)],
            ...extra,
          }),
        ],
        TABLE,
      ),
      ids: createCounterIdSource('n'),
    });
    const svg = target.query({ type: 'exportSvg' });
    expect(svg).not.toBeNull();
    return svg!;
  }

  it('writes an extend paint (stretch) as a clipped group using the one defs image', () => {
    const svg = svgOf(imagePaint('stretch'));
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(svg).toContain(
      `<image id="i1" href="${href}" width="1" height="1" preserveAspectRatio="none"/>`,
    );
    expect(svg).toContain('<clipPath id="c1"><path d="M0 0');
    expect(svg).toContain('clip-rule="nonzero"/></clipPath>');
    expect(svg).toContain(
      '<g clip-path="url(#c1)"><use href="#i1" xlink:href="#i1" transform="matrix(100 0 0 80 0 0)"/></g>',
    );
    expect(svg).not.toContain('<pattern');
    expect(svg.split(a.data)).toHaveLength(2);
  });

  it('writes a decal paint (fit) the same way, placed by its letterbox', () => {
    const svg = svgOf(imagePaint('fit'));
    expect(svg).toContain('xlink:href="#i1" transform="matrix(100 0 0 50 0 15)"/></g>');
    expect(svg).toContain('<g clip-path="url(#c1)">');
  });

  it('writes a repeat paint (tile) as a pattern of that image', () => {
    const svg = svgOf(imagePaint('tile', 0.5));
    expect(svg).toContain(
      `<image id="i1" href="${href}" width="1" height="1" preserveAspectRatio="none"/>`,
    );
    expect(svg).toContain(
      '<pattern id="p1" patternUnits="userSpaceOnUse" width="1" height="1" patternTransform="matrix(32 0 0 16 0 0)"><use href="#i1" xlink:href="#i1"/></pattern>',
    );
    expect(svg).toContain('fill="url(#p1)"');
    expect(svg).not.toContain('clip-path="url(#c');
  });

  it("keeps the shape's clip-rule for an evenodd path with a hole", () => {
    const target = createEditor({ ids: createCounterIdSource('n') });
    target.execute({ type: 'insertImages', assets: [a], at: { x: 50, y: 50 } });
    // A path takes the image paint through the existing create command: the key is held.
    const created = target.execute({
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'line', 'close', 'move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 100, 0, 100, 100, 0, 100, 25, 25, 25, 75, 75, 75, 75, 25],
      fillRule: 'evenodd',
      fills: [fill(imagePaint('fit')) as never],
      stroke: null,
    });
    expect(created.ok).toBe(true);
    const path = created.ok ? created.ids[0] : undefined;
    const svg = target.query({ type: 'exportSvg', ids: [path!] })!;
    expect(svg).toContain('clip-rule="evenodd"/></clipPath>');
    expect(svg).toContain('<g clip-path="url(#c1)"><use href="#i1"');
    expect(svg).not.toContain('fill-rule="evenodd"');
  });

  it("draws a stroke over the image fill, and an image fill opacity as the leaf's opacity", () => {
    const stroke = { color: red, width: 2, cap: 'butt', join: 'round', miterLimit: 4, dash: null };
    const withStroke = svgOf(imagePaint('stretch'), { stroke });
    expect(withStroke.indexOf('<image')).toBeLessThan(withStroke.indexOf('stroke="#ff0000"'));
    const half = svgOf(imagePaint('stretch'), {
      fills: [fill(imagePaint('stretch'), { opacity: 0.5 })],
    });
    expect(half).toContain('opacity="0.5"');
  });

  it('exports no image data for a document without the paint', () => {
    const target = createEditor({
      document: doc([node('r', 'p', 'rectangle', { fills: [fill(red)] })], undefined),
      ids: createCounterIdSource('n'),
    });
    const svg = target.query({ type: 'exportSvg' })!;
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('data:');
    expect(target.query({ type: 'exportScene' })).not.toHaveProperty('images');
  });
});

describe('an image used many times is written once', () => {
  it('shares one defs image between uses and a pattern, with distinct ids', () => {
    const target = createEditor({ ids: createCounterIdSource('n') });
    const first = target.execute({
      type: 'insertImages',
      assets: [a, a, a],
      at: { x: 50, y: 50 },
    });
    expect(first.ok).toBe(true);
    const ids = first.ok ? first.ids : [];
    target.execute({ type: 'setImagePaint', ids: [ids[2]!], scaleMode: 'tile' });
    const svg = target.query({ type: 'exportSvg' })!;
    expect(svg.split(a.data)).toHaveLength(2);
    expect(svg.match(/<image /gu)).toHaveLength(1);
    expect(svg.match(/<use /gu)).toHaveLength(3);
    const defined = [...svg.matchAll(/ id="([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(defined).size).toBe(defined.length);
  });
});

describe('noteImages reaches expansions and skips mask sources', () => {
  const rect = (id: string, parent: string, extra: Json = {}) =>
    node(id, parent, 'rectangle', extra);
  const unsupportedFor = (document: DocumentV8) => {
    const target = createEditor({ document, ids: createCounterIdSource('n') });
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    target.attachRenderer(new RecordingRenderer('supported', { paints: 'gradient' } as never));
    return seen.filter((event) => event.type === 'diagnostic');
  };

  it('counts an instance whose symbol lives on another page', () => {
    const value = {
      schemaVersion: 8,
      id: 'd',
      pages: [
        { id: 'p', name: 'P', children: ['i'] },
        { id: 'q', name: 'Q', children: ['s'] },
      ],
      nodes: {
        s: node('s', 'q', 'symbol', { children: ['x'], fills: [fill(red)], stroke: null }),
        x: rect('x', 's'),
        i: node('i', 'p', 'instance', { symbol: 's', textOverrides: {} }),
      },
      images: TABLE,
    };
    const result = validateDocument(value);
    if (!result.ok) throw new Error(result.path);
    expect(unsupportedFor(result.document)).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: ['i'],
      },
    ]);
  });

  it('does not count a mask source', () => {
    const document = doc([
      node('g', 'p', 'maskGroup', { children: ['s', 'c'], rotation: 0 }),
      node('s', 'g', 'path', {
        path: {
          verbs: ['move', 'line', 'line', 'close'],
          points: [0, 0, 1, 0, 1, 1],
          fillRule: 'nonzero',
        },
      }),
      rect('c', 'g', { fills: [fill(red)] }),
    ]);
    expect(unsupportedFor(document)).toEqual([]);
  });

  it('a mask source whose fill does not draw keeps its raw paint', () => {
    const projection = project(
      doc([
        node('g', 'p', 'maskGroup', { children: ['s', 'c'], rotation: 0 }),
        node('s', 'g', 'path', {
          path: {
            verbs: ['move', 'line', 'line', 'close'],
            points: [0, 0, 1, 0, 1, 1],
            fillRule: 'nonzero',
          },
          fills: [fill({ r: 0, g: 1, b: 0, a: 0.8 }, { opacity: 0 })],
        }),
        rect('c', 'g', { fills: [fill(red)] }),
      ]),
      false,
    );
    expect(styleFill(at(projection, 's'))).toEqual({ r: 0, g: 1, b: 0, a: 0.8 });
  });
});
