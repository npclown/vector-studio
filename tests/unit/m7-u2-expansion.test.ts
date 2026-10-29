import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateDocument, type DocumentV5, type NodeV5 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type Editor,
  type IdSource,
} from '../../packages/editor-core/src/index.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { applyEdit, applyGestureEdit, refitGesture } from '../../packages/editor-core/src/edits.js';
import {
  ExpansionCache,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_NODES_TOTAL,
  expandInstance,
  type Expansion,
} from '../../packages/editor-core/src/expansion.js';
import { apply, localTransform } from '../../packages/editor-core/src/geometry.js';

// MVP M7-U2 (M7 contract, sections 3 and 4.1, M7-S5 and section 1.2): `expandInstance` under
// M7-Q4 (c), expansion validity and the caps, the shared cache, the frame rules for `symbol`,
// and the clip depth through an expansion. Criteria M7-A02, M7-A06 and the clip-depth half of
// M7-A01.

const root = path.resolve(import.meta.dirname, '../..');
// Since M7-U7 the model returns schema v5, so each M7 fixture is read as its committed v5
// migration under tests/fixtures/m7-symbols/migrated (M6a contract, section 9).
const fixture = (name: string) =>
  readFileSync(
    path.join(
      root,
      'tests/fixtures/m7-symbols/migrated',
      `${path.basename(name).replace(/(\.v3)?\.json$/, '')}.v5.json`,
    ),
    'utf8',
  );
const SYMBOLS = fixture('symbols.v3.json');
const START = { horizontal: 'start', vertical: 'start' } as const;
const none = { shift: false, alt: false, meta: false, ctrl: false };

/** A document value as JSON, typed loosely for edits; leaves carry no `children` at run time. */
type JsonNode = {
  [key: string]: unknown;
  frame: { x: number; y: number; width: number; height: number };
  rotation: number;
  name: string;
  visible: boolean;
  constraints: unknown;
  children: string[];
};
type Json = { pages: { id: string; children: string[] }[]; nodes: Record<string, JsonNode> };

/** The symbols fixture after `edit`, read by the model. */
function symbols(edit: (value: Json) => void = () => {}): DocumentV5 {
  const value = JSON.parse(SYMBOLS) as Json;
  edit(value);
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function expanded(document: DocumentV5, id: string): Expansion {
  const result = expandInstance(document, id);
  if (result === null || !result.ok) throw new Error(`no expansion of ${id}`);
  return result.expansion;
}

const frameOf = (expansion: Expansion, id: string) => expansion.nodes.get(id)!.frame;

/** A rotated node's frame under the approximation: centre exact, size by MVP-Q3 (a). */
function approximated(
  node: NodeV5,
  sx: number,
  sy: number,
): { x: number; y: number; width: number; height: number } {
  const { x, y, width, height } = node.frame;
  const cos = Math.cos(node.rotation);
  const sin = Math.sin(node.rotation);
  const w = width * Math.hypot(sx * cos, sy * sin);
  const h = height * Math.hypot(sx * sin, sy * cos);
  const cx = sx * (x + width / 2);
  const cy = sy * (y + height / 2);
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

const ORDER = ['s1-r', 's1-g', 's1-e', 's1-p', 's1-f', 's1-l'];

describe('M7-A02 expandInstance', () => {
  it('at equal size returns the source descendants themselves, rotated ones included', () => {
    const document = symbols();
    const expansion = expanded(document, 'i1');
    expect(expansion.children).toEqual(['s1-r', 's1-g', 's1-f']);
    expect([...expansion.nodes.keys()]).toEqual(ORDER);
    for (const id of ORDER) {
      expect(expansion.nodes.get(id)).toBe(document.nodes[id]);
      expect(expansion.nodes.get(id)).toEqual(document.nodes[id]);
    }
    expect(document.nodes['s1-r']!.rotation).toBe(0.5);
  });

  // Instance sizes against the 100 × 80 source s1: [instance, sx, sy, literal frames].
  it.each<[string, (value: Json) => void, number, number, Record<string, object>]>([
    [
      'larger (i2, 200 × 160, rotated instance)',
      () => {},
      2,
      2,
      {
        's1-g': { x: 100, y: 20, width: 80, height: 60 },
        's1-e': { x: 0, y: 0, width: 40, height: 40 },
        's1-p': { x: 40, y: 20, width: 40, height: 40 },
        's1-f': { x: 20, y: 90, width: 160, height: 60 },
        's1-l': { x: 0, y: 30, width: 160, height: 0 },
      },
    ],
    [
      'smaller (50 × 40)',
      (value) => {
        value.nodes.i2!.frame = { x: 0, y: 0, width: 50, height: 40 };
      },
      0.5,
      0.5,
      {
        's1-g': { x: 25, y: 5, width: 20, height: 15 },
        's1-e': { x: 0, y: 0, width: 10, height: 10 },
        's1-p': { x: 10, y: 5, width: 10, height: 10 },
        's1-f': { x: 5, y: 22.5, width: 40, height: 15 },
        's1-l': { x: 0, y: 7.5, width: 40, height: 0 },
      },
    ],
    [
      'non-uniform (150 × 40)',
      (value) => {
        value.nodes.i2!.frame = { x: 0, y: 0, width: 150, height: 40 };
      },
      1.5,
      0.5,
      {
        's1-g': { x: 75, y: 5, width: 60, height: 15 },
        's1-e': { x: 0, y: 0, width: 30, height: 10 },
        's1-p': { x: 30, y: 5, width: 30, height: 10 },
        's1-f': { x: 15, y: 22.5, width: 120, height: 15 },
        's1-l': { x: 0, y: 7.5, width: 120, height: 0 },
      },
    ],
    [
      'a zero source axis (source width 0, instance 100 × 160)',
      (value) => {
        value.nodes.s1!.frame.width = 0;
        value.nodes.i2!.frame = { x: 0, y: 0, width: 100, height: 160 };
      },
      1,
      2,
      {
        's1-g': { x: 50, y: 20, width: 40, height: 60 },
        's1-e': { x: 0, y: 0, width: 20, height: 40 },
        's1-p': { x: 20, y: 20, width: 20, height: 40 },
        's1-f': { x: 10, y: 90, width: 80, height: 60 },
        's1-l': { x: 0, y: 30, width: 80, height: 0 },
      },
    ],
  ])('%s maps as a group resize, literally', (_name, edit, sx, sy, frames) => {
    const document = symbols(edit);
    const expansion = expanded(document, 'i2');
    expect([...expansion.nodes.keys()]).toEqual(ORDER);
    // The rotated rectangle takes the approximation about its exact centre.
    expect(frameOf(expansion, 's1-r')).toEqual(approximated(document.nodes['s1-r']!, sx, sy));
    expect(expansion.nodes.get('s1-r')!.rotation).toBe(0.5);
    for (const [id, frame] of Object.entries(frames)) expect(frameOf(expansion, id)).toEqual(frame);
    for (const id of ORDER) {
      const source = document.nodes[id]! as Record<string, unknown>;
      const copy = expansion.nodes.get(id)! as Record<string, unknown>;
      // Only the frame changes: parent, rotation, styles (stroke widths), radii and points stay.
      expect({ ...copy, frame: null }).toEqual({ ...source, frame: null });
    }
  });

  it('maps a rotated path exactly under a non-uniform scale', () => {
    const document = symbols((value) => {
      value.nodes['s1-p']!.rotation = 0.3;
      value.nodes.i2!.frame = { x: 0, y: 0, width: 150, height: 40 };
    });
    const expansion = expanded(document, 'i2');
    /** The path's points in the source's local space. */
    const points = (group: NodeV5, node: NodeV5) => {
      if (node.type !== 'path') throw new Error('not a path');
      const out: number[] = [];
      const inGroup = localTransform(node.frame, node.rotation);
      const outer = localTransform(group.frame, group.rotation);
      for (let i = 0; i < node.path.points.length; i += 2) {
        const p = apply(
          inGroup,
          node.path.points[i]! * node.frame.width,
          node.path.points[i + 1]! * node.frame.height,
        );
        const q = apply(outer, p.x, p.y);
        out.push(q.x, q.y);
      }
      return out;
    };
    const before = points(document.nodes['s1-g']!, document.nodes['s1-p']!);
    const after = points(expansion.nodes.get('s1-g')!, expansion.nodes.get('s1-p')!);
    expect(expansion.nodes.get('s1-p')!.rotation).toBe(0.3);
    after.forEach((value, i) =>
      expect(value).toBeCloseTo(before[i]! * (i % 2 === 0 ? 1.5 : 0.5), 9),
    );
  });

  it('is deterministic and ignores the source placement fields', () => {
    const a = expanded(symbols(), 'i2');
    const b = expanded(
      symbols((value) => {
        value.nodes.s1!.frame.x = 999;
        value.nodes.s1!.frame.y = -5;
        value.nodes.s1!.rotation = 1;
        value.nodes.s1!.name = 'Other';
        value.nodes.s1!.visible = false;
        value.nodes.s1!.constraints = { horizontal: 'scale', vertical: 'end' };
      }),
      'i2',
    );
    expect(b).toEqual(a);
    expect(expandInstance(symbols(), 's1')).toBeNull();
    expect(expandInstance(symbols(), 'missing')).toBeNull();
  });

  it('expands an empty source to nothing', () => {
    const expansion = expanded(symbols(), 'i3');
    expect(expansion.children).toEqual([]);
    expect(expansion.nodes.size).toBe(0);
  });
});

/** The symbols fixture with a source width so small that the instances' scale overflows. */
const overflowing = (value: Json) => {
  value.nodes.s1!.frame.width = 1e-305;
};

describe('M7-X3 expansion validity', () => {
  it('an Infinity scale fails at the instance with the first failing source node', () => {
    expect(expandInstance(symbols(overflowing), 'i1')).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i1',
      node: 's1-r',
    });
  });

  it('a custom node whose resized copy fails its extension check fails the expansion', () => {
    const document = symbols((value) => {
      value.nodes['s1-c'] = {
        id: 's1-c',
        name: 'Star',
        parent: 's1',
        frame: { x: 0, y: 0, width: 40, height: 40 },
        rotation: 0,
        constraints: START,
        opacity: 1,
        visible: true,
        type: 'custom',
        customType: 'ext.star',
        data: { innerRatio: 0.5, points: 5 },
        fill: null,
        stroke: null,
      } as unknown as JsonNode;
      value.nodes.s1!.children.push('s1-c');
    });
    const wide = (node: NodeV5) =>
      node.type === 'custom' && node.frame.width > 50
        ? { code: 'document.invalid-custom-data' as const, path: '/data' }
        : null;
    expect(expandInstance(document, 'i2', wide)).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i2',
      node: 's1-c',
    });
    // At equal size the copy is the document node, which the load check already covers.
    expect(expandInstance(document, 'i1', wide)).toMatchObject({ ok: true });
  });

  it('a load with an invalid expansion fails with the first instance in page order', () => {
    const target = createEditor();
    expect(target.execute({ type: 'loadDocument', document: symbols(overflowing) })).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i1',
    });
    expect(() => createEditor({ document: symbols(overflowing) })).toThrow(
      'createEditor: editor.invalid-expansion at /nodes/i1',
    );
  });

  it('a command that makes an expansion invalid fails and changes nothing', () => {
    const target = createEditor({ document: symbols() });
    const before = target.query({ type: 'document' });
    const frame = { x: 0, y: 0, width: 1e-305, height: 80 };
    expect(target.execute({ type: 'setFrames', frames: [{ id: 's1', frame }] })).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i1',
    });
    expect(target.query({ type: 'document' })).toBe(before);
    // A gesture update applies the command without refit and fails the same way.
    const update = applyEdit(
      before,
      { type: 'setFrames', frames: [{ id: 's1', frame }] },
      { ids: () => 'x', activePage: 'page-1', refit: false, resizeBase: before },
    );
    expect(update).toEqual({ ok: false, code: 'editor.invalid-expansion', path: '/nodes/i1' });
    // Resizing an instance checks its own expansion.
    const huge = { x: 0, y: 0, width: 1e308, height: 80 };
    const small = createEditor({
      document: symbols((value) => {
        value.nodes.s1!.frame.width = 1;
      }),
    });
    expect(small.execute({ type: 'setFrames', frames: [{ id: 'i3', frame: huge }] }).ok).toBe(true);
    expect(small.execute({ type: 'setFrames', frames: [{ id: 'i1', frame: huge }] })).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i1',
    });
  });
});

/**
 * A document whose page 1 holds a source `s` (no fill or stroke) with `rects` rectangles, and
 * `perPage[k]` instances of it on page k + 1 (`i-<page>-<n>`).
 */
function capDocument(perPage: readonly number[], rects: number): Json {
  const base = (id: string, parent: string) => ({
    id,
    name: id,
    parent,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
  });
  const nodes: Record<string, unknown> = {};
  const children: string[] = [];
  for (let n = 1; n <= rects; n += 1) {
    const id = `r-${n}`;
    children.push(id);
    nodes[id] = {
      ...base(id, 's'),
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: { r: 1, g: 0, b: 0, a: 1 },
      stroke: null,
    };
  }
  nodes.s = { ...base('s', 'p-1'), type: 'symbol', children, fill: null, stroke: null };
  const pages = perPage.map((count, k) => {
    const page = `p-${k + 1}`;
    const ids = Array.from({ length: count }, (_, n) => `i-${k + 1}-${n + 1}`);
    for (const id of ids)
      nodes[id] = { ...base(id, page), type: 'instance', symbol: 's', textOverrides: {} };
    return { id: page, name: page, children: k === 0 ? ['s', ...ids] : ids };
  });
  return { schemaVersion: 5, id: 'cap', pages, nodes } as unknown as Json;
}

describe('M7 section 4.1 expansion caps', () => {
  it('counts the scene nodes an instance adds', () => {
    const cache = new ExpansionCache();
    // s1: outer, content, background, border; six nodes; s1-f's content and background.
    expect(cache.count(symbols(), 's1')).toBe(4 + 6 + 2);
    expect(cache.count(symbols(), 's2')).toBe(2);
    expect(MAX_EXPANDED_NODES).toBe(100_000);
    expect(MAX_EXPANDED_NODES_TOTAL).toBe(1_000_000);
  });

  it('a page may hold 100,000 expanded scene nodes, not one more', () => {
    // 1,000 scene nodes per instance: the outer and content nodes and 998 rectangles.
    expect(
      createEditor().execute({ type: 'loadDocument', document: capDocument([100], 998) }),
    ).toEqual({
      ok: true,
      ids: [],
    });
    expect(
      createEditor().execute({ type: 'loadDocument', document: capDocument([101], 998) }),
    ).toEqual({
      ok: false,
      code: 'editor.expansion-limit',
      path: '/nodes/i-1-101',
    });
  });

  it('a document over the total fails although every page is under its own cap', () => {
    const pages = Array.from({ length: 11 }, () => 100);
    expect(
      createEditor().execute({ type: 'loadDocument', document: capDocument(pages, 998) }),
    ).toEqual({
      ok: false,
      code: 'editor.expansion-limit',
      path: '/nodes/i-11-1',
    });
  });

  it('a command that crosses the cap fails, changes nothing and draws no ID', () => {
    let drawn = 0;
    const ids: IdSource = () => `new-${(drawn += 1)}`;
    const target = createEditor({ document: capDocument([100], 998), ids });
    drawn = 0;
    const before = target.query({ type: 'document' });
    const command: Command = {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 5, height: 5 },
      parent: 's',
    };
    // 1,001 scene nodes per instance: the 100th instance crosses 100,000.
    expect(target.execute(command)).toEqual({
      ok: false,
      code: 'editor.expansion-limit',
      path: '/nodes/i-1-100',
    });
    expect(target.query({ type: 'document' })).toBe(before);
    expect(drawn).toBe(0);
  });

  it('reports an invalid expansion before the cap, and the clip depth before both', () => {
    const value = capDocument([101], 998);
    value.nodes['i-1-1']!.frame.width = 1e308;
    value.nodes.s!.frame.width = 1e-300;
    expect(createEditor().execute({ type: 'loadDocument', document: value })).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i-1-1',
    });
    const deep = JSON.parse(fixture('depth/clip-33.json')) as Json;
    deep.nodes.s!.frame.width = 1e-305;
    expect(createEditor().execute({ type: 'loadDocument', document: deep })).toMatchObject({
      code: 'editor.clip-depth',
    });
  });
});

describe('M7-S5 clip depth through an expansion (M7-A01, clip-depth half)', () => {
  it('loads depth/clip-32.json and fails depth/clip-33.json at the instance', () => {
    const target = createEditor();
    const clip32 = JSON.parse(fixture('depth/clip-32.json')) as unknown;
    const clip33 = JSON.parse(fixture('depth/clip-33.json')) as unknown;
    // Both pass the model; the bound is the editor's.
    expect(validateDocument(clip32).ok).toBe(true);
    expect(validateDocument(clip33).ok).toBe(true);
    expect(target.execute({ type: 'loadDocument', document: clip32 })).toEqual({
      ok: true,
      ids: [],
    });
    expect(target.execute({ type: 'loadDocument', document: clip33 })).toEqual({
      ok: false,
      code: 'editor.clip-depth',
      path: '/nodes/i/parent',
    });
    expect(() => createEditor({ document: clip33 })).toThrow(
      'createEditor: editor.clip-depth at /nodes/i/parent',
    );
  });

  it('fails a command that deepens an expansion past the bound, at the instance', () => {
    const target = createEditor({ document: JSON.parse(fixture('depth/clip-32.json')) as unknown });
    const before = target.query({ type: 'document' });
    const frame = { x: 0, y: 0, width: 1, height: 1 };
    // A frame inside the source's innermost frame sits at clip level 15 below the source, so
    // its expanded copy would sit at 16 + 1 + 15 = 32.
    expect(target.execute({ type: 'createFrame', frame, parent: 'a14' })).toEqual({
      ok: false,
      code: 'editor.clip-depth',
      path: '/nodes/i/parent',
    });
    expect(target.query({ type: 'document' })).toBe(before);
    // The instance moved one frame deeper.
    const created = target.execute({ type: 'createFrame', frame, parent: 'b15' });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.ids[0]! : '';
    expect(target.execute({ type: 'moveNodes', ids: ['i'], parent: id, index: 0 })).toEqual({
      ok: false,
      code: 'editor.clip-depth',
      path: '/nodes/i/parent',
    });
  });

  it('an instance projects as a frame: it may sit at clip depth 31, not 32', () => {
    const nested = (frames: number): Json => {
      const value = capDocument([0], 0);
      let parent = 'p-1';
      for (let n = 0; n < frames; n += 1) {
        const id = `f${n}`;
        value.nodes[id] = {
          id,
          name: id,
          parent,
          frame: { x: 0, y: 0, width: 10, height: 10 },
          rotation: 0,
          constraints: START,
          opacity: 1,
          visible: true,
          type: 'frame',
          children: [],
          fill: null,
          stroke: null,
        };
        if (parent === 'p-1') value.pages[0]!.children.push(id);
        else value.nodes[parent]!.children.push(id);
        parent = id;
      }
      value.nodes.i = {
        id: 'i',
        name: 'i',
        parent,
        frame: { x: 0, y: 0, width: 10, height: 10 },
        rotation: 0,
        constraints: START,
        opacity: 1,
        visible: true,
        type: 'instance',
        symbol: 's',
        textOverrides: {},
      } as unknown as JsonNode;
      value.nodes[parent]!.children.push('i');
      return value;
    };
    expect(createEditor().execute({ type: 'loadDocument', document: nested(31) })).toEqual({
      ok: true,
      ids: [],
    });
    expect(createEditor().execute({ type: 'loadDocument', document: nested(32) })).toEqual({
      ok: false,
      code: 'editor.clip-depth',
      path: '/nodes/i/parent',
    });
  });
});

describe('M7-X4 the expansion cache', () => {
  it('reuses results by node identity, and subtrees while their nodes and scale hold', () => {
    const target = createEditor({ document: symbols() });
    /** Runs `command` and returns the editor's new document. */
    const after = (_document: DocumentV5, command: Command): DocumentV5 => {
      expect(target.execute(command).ok).toBe(true);
      return target.query({ type: 'document' });
    };
    const cache = new ExpansionCache();
    const document = target.query({ type: 'document' });
    const first = cache.expand(document, 'i2');
    expect(cache.computed).toBe(3);
    expect(cache.expand(document, 'i2')).toBe(first);
    // An unrelated change keeps the result object.
    const moved = after(document, {
      type: 'setFrames',
      frames: [{ id: 'd1-r', frame: { x: 0, y: 0, width: 10, height: 10 } }],
    });
    expect(cache.expand(moved, 'i2')).toBe(first);
    expect(cache.computed).toBe(3);
    // A source fill change gives a new result of the same expanded node objects.
    const filled = after(moved, {
      type: 'setNodeProps',
      id: 's1',
      props: { fill: { r: 0, g: 1, b: 0, a: 1 } },
    });
    const second = cache.expand(filled, 'i2');
    expect(second).not.toBe(first);
    expect(cache.computed).toBe(3);
    const nodesOf = (result: typeof first) => (result?.ok ? result.expansion.nodes : new Map());
    for (const id of ORDER) expect(nodesOf(second).get(id)).toBe(nodesOf(first).get(id));
    // A change below one source child recomputes that subtree only.
    const edited = after(filled, {
      type: 'setFrames',
      frames: [{ id: 's1-e', frame: { x: 0, y: 0, width: 10, height: 10 } }],
    });
    const third = cache.expand(edited, 'i2');
    expect(cache.computed).toBe(4);
    for (const id of ['s1-r', 's1-f', 's1-l']) {
      expect(nodesOf(third).get(id)).toBe(nodesOf(second).get(id));
    }
    expect(nodesOf(third).get('s1-e')).not.toBe(nodesOf(second).get('s1-e'));
    // A resized instance recomputes every subtree.
    const resized = after(edited, {
      type: 'setFrames',
      frames: [{ id: 'i2', frame: { x: 0, y: 0, width: 100, height: 100 } }],
    });
    cache.expand(resized, 'i2');
    expect(cache.computed).toBe(7);
  });
});

describe('M7-A06 a symbol follows the frame rules', () => {
  /** s1's children after a resize from 100 × 80 to 200 × 160 by their constraints. */
  const resizedChildren = (document: DocumentV5) => {
    const nodes = document.nodes;
    expect(nodes['s1-r']).toEqual(symbols().nodes['s1-r']);
    expect(nodes['s1-g']).toEqual(symbols().nodes['s1-g']);
    // startEnd horizontally and end vertically; the line inside scales and stays centred.
    expect(nodes['s1-f']!.frame).toEqual({ x: 10, y: 125, width: 180, height: 30 });
    expect(nodes['s1-l']!.frame).toEqual({ x: 0, y: 15, width: 180, height: 0 });
  };

  it("applies its children's constraints when resized", () => {
    const target = createEditor({ document: symbols() });
    const frame = { x: 0, y: 0, width: 200, height: 160 };
    expect(target.execute({ type: 'setFrames', frames: [{ id: 's1', frame }] }).ok).toBe(true);
    const document = target.query({ type: 'document' });
    resizedChildren(document);
    // i1 (100 × 80) now shows the source at half its size.
    expect(frameOf(expanded(document, 'i1'), 's1-f')).toEqual({
      x: 5,
      y: 62.5,
      width: 90,
      height: 15,
    });
  });

  it('maps as a frame inside a resized group', () => {
    const target = createEditor({ document: symbols() });
    const grouped = target.execute({ type: 'groupNodes', ids: ['s1', 'i1'], kind: 'group' });
    expect(grouped.ok).toBe(true);
    const group = grouped.ok ? grouped.ids[0]! : '';
    expect(target.query({ type: 'node', id: group })!.frame).toEqual({
      x: 0,
      y: 0,
      width: 240,
      height: 80,
    });
    const frame = { x: 0, y: 0, width: 480, height: 160 };
    expect(target.execute({ type: 'setFrames', frames: [{ id: group, frame }] }).ok).toBe(true);
    const document = target.query({ type: 'document' });
    expect(document.nodes.s1!.frame).toEqual({ x: 0, y: 0, width: 200, height: 160 });
    expect(document.nodes.i1!.frame).toEqual({ x: 280, y: 0, width: 200, height: 160 });
    resizedChildren(document);
    // The instance and its source scaled together, so its content equals the source's.
    for (const id of ORDER) expect(expanded(document, 'i1').nodes.get(id)).toBe(document.nodes[id]);
  });

  it('is entered as a scope, and a top-level symbol is skipped on the way out like an artboard', () => {
    const target = createEditor({ document: symbols() });
    const key = (name: string) =>
      target.execute({ type: 'input', event: { kind: 'keydown', key: name, modifiers: none } });
    expect(target.execute({ type: 'setSelection', ids: ['s1'] }).ok).toBe(true);
    key('Enter');
    expect(target.query({ type: 'scope' })).toBe('s1');
    expect(target.query({ type: 'selection' })).toEqual(['s1-r', 's1-g', 's1-f']);
    expect(target.execute({ type: 'setScope', id: 's1-g' }).ok).toBe(true);
    key('Escape');
    // Not into s1: a top-level symbol's children are targets at the page already.
    expect(target.query({ type: 'selection' })).toEqual(['s1-g']);
    expect(target.query({ type: 'scope' })).toBeNull();
  });
});

describe('M7-U2 editor documents stay valid', () => {
  it('every expansion of the fixture is valid and the editor loads it', () => {
    const document = symbols();
    for (const id of ['i1', 'i2', 'i3', 'i4']) {
      expect(expandInstance(document, id)).toMatchObject({ ok: true });
    }
    expect(createEditor().execute({ type: 'loadDocument', document })).toEqual({
      ok: true,
      ids: [],
    });
  });

  it('keeps expansions stable across undo', () => {
    const target: Editor = createEditor({ document: symbols() });
    const before = expanded(target.query({ type: 'document' }), 'i2');
    const frame = { x: 0, y: 0, width: 200, height: 160 };
    expect(target.execute({ type: 'setFrames', frames: [{ id: 's1', frame }] }).ok).toBe(true);
    expect(expanded(target.query({ type: 'document' }), 'i2')).not.toEqual(before);
    expect(target.execute({ type: 'undo' }).ok).toBe(true);
    expect(expanded(target.query({ type: 'document' }), 'i2')).toEqual(before);
  });
});

describe('M7-U2 review follow-ups (S3)', () => {
  it('a cap crossing before a later invalid instance reports the cap at the crossing instance', () => {
    // 102 instances of 1,000 scene nodes: i-1-101 crosses 100,000 and i-1-102 is invalid.
    const value = capDocument([102], 998);
    value.nodes.s!.frame.width = 1e-300;
    value.nodes['i-1-102']!.frame.width = 1e308;
    expect(createEditor().execute({ type: 'loadDocument', document: value })).toEqual({
      ok: false,
      code: 'editor.expansion-limit',
      path: '/nodes/i-1-101',
    });
  });

  it('resizing only the source recomputes the cached subtrees', () => {
    const target = createEditor({ document: symbols() });
    const cache = new ExpansionCache();
    const first = cache.expand(target.query({ type: 'document' }), 'i2');
    expect(cache.computed).toBe(3);
    const frame = { x: 0, y: 0, width: 200, height: 160 };
    expect(target.execute({ type: 'setFrames', frames: [{ id: 's1', frame }] }).ok).toBe(true);
    const document = target.query({ type: 'document' });
    const second = cache.expand(document, 'i2');
    expect(cache.computed).toBe(6);
    expect(second).not.toEqual(first);
    // i2 (200 × 160) now has the source's size: its copies are the source's nodes.
    for (const id of ORDER) {
      expect(second?.ok ? second.expansion.nodes.get(id) : null).toBe(document.nodes[id]);
    }
  });

  it('reuses subtrees at the same scale with different sizes', () => {
    const target = createEditor({ document: symbols() });
    const cache = new ExpansionCache();
    const first = cache.expand(target.query({ type: 'document' }), 'i2');
    expect(cache.computed).toBe(3);
    // Source 50 × 40 and instance 100 × 80: the scale stays 2. s1-r and s1-g have start
    // constraints and keep their node objects; s1-f stretches and is recomputed.
    expect(
      target.execute({
        type: 'setFrames',
        frames: [
          { id: 's1', frame: { x: 0, y: 0, width: 50, height: 40 } },
          { id: 'i2', frame: { x: 0, y: 0, width: 100, height: 80 } },
        ],
      }).ok,
    ).toBe(true);
    const second = cache.expand(target.query({ type: 'document' }), 'i2');
    expect(cache.computed).toBe(4);
    const nodesOf = (result: typeof first) => (result?.ok ? result.expansion.nodes : new Map());
    for (const id of ['s1-r', 's1-g', 's1-e', 's1-p']) {
      expect(nodesOf(second).get(id)).toBe(nodesOf(first).get(id));
    }
    expect(nodesOf(second).get('s1-f')).not.toBe(nodesOf(first).get('s1-f'));
  });

  it("the editor's shared cache follows undo and redo", () => {
    const target = createEditor({ document: symbols() });
    const cache = internalsOf(target).expansions;
    const current = () => cache.expand(target.query({ type: 'document' }), 'i2');
    const before = current();
    const fill = { r: 0, g: 1, b: 0, a: 1 };
    expect(target.execute({ type: 'setNodeProps', id: 's1-r', props: { fill } }).ok).toBe(true);
    // The command's own check already expanded i2 in the editor's cache.
    const computed = cache.computed;
    const edited = current();
    expect(cache.computed).toBe(computed);
    expect(edited?.ok && (edited.expansion.nodes.get('s1-r') as { fill: unknown }).fill).toEqual(
      fill,
    );
    expect(target.execute({ type: 'undo' }).ok).toBe(true);
    const undone = current();
    expect(undone).toEqual(before);
    // Only the s1-r subtree is recomputed; the others are the same objects.
    expect(cache.computed).toBe(computed + 1);
    const nodesOf = (result: typeof before) => (result?.ok ? result.expansion.nodes : new Map());
    for (const id of ['s1-g', 's1-e', 's1-p', 's1-f', 's1-l']) {
      expect(nodesOf(undone).get(id)).toBe(nodesOf(edited).get(id));
    }
    expect(target.execute({ type: 'redo' }).ok).toBe(true);
    expect(current()).toEqual(edited);
    expect(cache.computed).toBe(computed + 2);
  });

  it('checks the expansions in a gesture edit and at the commit refit', () => {
    const document = symbols();
    // A page-space map that shrinks s1 to a width of 1e-305 overflows i1's scale.
    const map = { sx: 1e-307, sy: 1, ox: 0, oy: 0, tx: 0, ty: 0, psi: 0 };
    expect(applyGestureEdit(document, document, { kind: 'map', ids: ['s1'], map })).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i1',
    });
    // The commit refit checks the live document again.
    const live = symbols(overflowing);
    expect(refitGesture(live, live, [])).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i1',
    });
    expect(refitGesture(document, document, [])).toMatchObject({ ok: true });
  });

  describe('groupNodes, duplicateNodes and paste into a source', () => {
    /** An editor on a page at the cap, counting the IDs it draws after construction. */
    const atCap = () => {
      const counter = { drawn: 0 };
      const ids: IdSource = () => `new-${(counter.drawn += 1)}`;
      const target = createEditor({ document: capDocument([100], 998), ids });
      counter.drawn = 0;
      return { target, counter, before: target.query({ type: 'document' }) };
    };
    const limit = { ok: false, code: 'editor.expansion-limit', path: '/nodes/i-1-100' };

    it.each<[string, Command[]]>([
      ['groupNodes', [{ type: 'groupNodes', ids: ['r-1', 'r-2'], kind: 'group' }]],
      ['duplicateNodes', [{ type: 'duplicateNodes', ids: ['r-1'] }]],
      ['paste', [{ type: 'paste' }]],
    ])('%s fails at the cap and draws no ID', (name, commands) => {
      const { target, counter } = atCap();
      if (name === 'paste') {
        expect(target.execute({ type: 'copy', ids: ['r-1'] }).ok).toBe(true);
        expect(target.execute({ type: 'setScope', id: 's' }).ok).toBe(true);
      }
      const before = target.query({ type: 'document' });
      for (const command of commands) expect(target.execute(command)).toEqual(limit);
      expect(target.query({ type: 'document' })).toBe(before);
      expect(counter.drawn).toBe(0);
    });

    it('a duplicate whose copy overflows an instance fails with invalid-expansion', () => {
      const value = capDocument([1], 2);
      value.nodes.s!.frame.width = 1e-300;
      let drawn = 0;
      const target = createEditor({ document: value, ids: () => `new-${(drawn += 1)}` });
      drawn = 0;
      const before = target.query({ type: 'document' });
      expect(
        target.execute({ type: 'duplicateNodes', ids: ['r-1'], offset: { x: 1e10, y: 0 } }),
      ).toEqual({ ok: false, code: 'editor.invalid-expansion', path: '/nodes/i-1-1' });
      expect(target.query({ type: 'document' })).toBe(before);
      expect(drawn).toBe(0);
    });
  });
});
