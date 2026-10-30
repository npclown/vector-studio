import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  parseEnvelope,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV6,
  type PathData,
  type Stroke,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  DEFAULT_PATH_STROKE,
  DEFAULT_SHAPE_STROKE,
  starExtension,
  type Command,
  type CommandResult,
  type Editor,
  type IdSource,
  type StyleProps,
} from '../../packages/editor-core/src/index.js';
import { deepestHit } from '../../packages/editor-core/src/hit-test.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import {
  documentIsolationViolation,
  effectiveOpacity,
  isolationCount,
  documentTree,
} from '../../packages/editor-core/src/tree.js';

// MVP M4-U3 (M4 contract, sections 2.1 M4-L1 and M4-M2, 3 M4-P6, 4.2, 4.3 and 5): the opacity
// lift for containers and instances at v6 while older inputs still fail; the instance's
// effective opacity, instance × source (M4-Q15 (a)), in the projection and on detach; the
// isolation count of section 4.3 on load and in commands, with its precedence (M4-A08); the
// `setStyle` command (M4-A09); the rest of M4-A10 (the effective-opacity product and detach);
// and hit testing unchanged (M4-A11). Documents are literal and validated by the model.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const clear = { r: 1, g: 0, b: 0, a: 0 };

type Loose = Record<string, unknown>;
type Json = { schemaVersion: number; id: string; pages: Loose[]; nodes: Record<string, Loose> };

const base = (id: string, parent: string, extra: Loose = {}): Loose => ({
  id,
  name: id,
  parent,
  frame: { x: 0, y: 0, width: 100, height: 50 },
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
  ...extra,
});
const rect = (id: string, parent: string, extra: Loose = {}): Loose =>
  base(id, parent, {
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
    ...extra,
  });
const group = (id: string, parent: string, children: string[], extra: Loose = {}): Loose =>
  base(id, parent, { type: 'group', children, ...extra });
const frame = (id: string, parent: string, children: string[] = [], extra: Loose = {}): Loose =>
  base(id, parent, { type: 'frame', children, fill: null, stroke: null, ...extra });
const symbol = (id: string, parent: string, children: string[] = [], extra: Loose = {}): Loose =>
  base(id, parent, { type: 'symbol', children, fill: null, stroke: null, ...extra });
const instance = (id: string, parent: string, source: string, extra: Loose = {}): Loose =>
  base(id, parent, { type: 'instance', symbol: source, textOverrides: {}, ...extra });

/** A v6 document; `pages` maps each page ID to its children. */
function doc(pages: Record<string, string[]>, nodes: Loose[], version = 6): Json {
  return {
    schemaVersion: version,
    id: 'd',
    pages: Object.entries(pages).map(([id, children]) => ({ id, name: id, children })),
    nodes: Object.fromEntries(nodes.map((node) => [node.id as string, node])),
  };
}

/**
 * `levels` nested groups `${prefix}0` (under `parent`) to `${prefix}${levels - 1}`, each at
 * `opacity`, the innermost holding `inner`; returns the nodes, outermost first.
 */
function chain(
  prefix: string,
  parent: string,
  levels: number,
  inner: string[],
  opacity = 0.5,
  extra: (level: number) => Loose = () => ({}),
): Loose[] {
  const nodes: Loose[] = [];
  for (let level = 0; level < levels; level += 1) {
    const children = level + 1 < levels ? [`${prefix}${level + 1}`] : inner;
    const owner = level === 0 ? parent : `${prefix}${level - 1}`;
    nodes.push(group(`${prefix}${level}`, owner, children, { opacity, ...extra(level) }));
  }
  return nodes;
}

function parsed(value: Json): DocumentV6 {
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function counted(document: unknown) {
  let count = 0;
  const ids: IdSource = () => `n${++count}`;
  const target = createEditor({ document, ids, extensions: [starExtension] });
  return { target, drawn: () => count };
}
const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));

function ok(target: Editor, command: Command): readonly string[] {
  const result: CommandResult = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
  return result.ids;
}

/** `command` fails with `failure`, changes nothing, draws no ID and records no step. */
function fails(
  setup: { target: Editor; drawn: () => number },
  command: Command,
  failure: { code: string; path?: string },
): void {
  const { target, drawn } = setup;
  const before = text(target);
  const document = target.query({ type: 'document' });
  const history = target.query({ type: 'history' });
  const count = drawn();
  expect(target.execute(command)).toEqual({ ok: false, ...failure });
  expect(target.query({ type: 'document' })).toBe(document);
  expect(text(target)).toBe(before);
  expect(drawn()).toBe(count);
  expect(target.query({ type: 'history' })).toEqual(history);
}

/** `value` fails to load with `failure`, through `createEditor` and `loadDocument`. */
function loadFails(value: Json, code: string, path: string): void {
  expect(() => createEditor({ document: value })).toThrow(`createEditor: ${code} at ${path}`);
  const target = createEditor();
  expect(target.execute({ type: 'loadDocument', document: value })).toEqual({
    ok: false,
    code,
    path,
  });
}

const loads = (value: Json) => {
  expect(() => createEditor({ document: value })).not.toThrow();
};

const unitTriangle: PathData = {
  verbs: ['move', 'line', 'line', 'close'],
  points: [0, 0, 1, 0, 0.5, 1],
  fillRule: 'nonzero',
};
const custom = () => unitTriangle;
const project = (document: DocumentV6, page: string) => projectPage(document, page, custom).nodes;
const containerOf = (nodes: ReadonlyMap<string, RenderNodeSnapshot>, id: string) =>
  nodes.get(id) as Extract<RenderNodeSnapshot, { kind: 'container' }>;

const MARKER = 'vector-studio/fragment\n';
const fragment = (body: unknown) => MARKER + JSON.stringify(body);

describe('M4-A08 the opacity lift (M4-L1, M4-M2, M4-S5)', () => {
  const containers = (opacity: number) =>
    doc({ p: ['g', 'm', 'f', 'i'], q: ['s'] }, [
      group('g', 'p', ['g-r'], { opacity }),
      rect('g-r', 'g'),
      base('m', 'p', {
        type: 'maskGroup',
        children: ['m-p', 'm-r'],
        opacity,
      }),
      base('m-p', 'm', {
        type: 'path',
        path: unitTriangle,
        fill: black,
        stroke: null,
      }),
      rect('m-r', 'm'),
      frame('f', 'p', [], { opacity }),
      instance('i', 'p', 's', { opacity }),
      symbol('s', 'q', [], { opacity }),
    ]);

  it('loads containers and instances at 0, 0.5 and 1 at v6, at every document entry point', () => {
    for (const opacity of [0, 0.5, 1]) {
      const value = containers(opacity);
      expect(validateDocument(value).ok).toBe(true);
      expect(validateAnyDocument(value).ok).toBe(true);
      expect(
        parseEnvelope(JSON.stringify({ envelopeVersion: 1, lastOpenPageId: 'p', document: value }))
          .ok,
      ).toBe(true);
      const result = validateDocument(value);
      expect(result.ok && serializeDocument(result.document)).toBe(
        serializeDocument(parsed(value)),
      );
      loads(value);
    }
  });

  it('still fails a v5 or older input at opacity 0.5 (M4-M2), with the v5 field order', () => {
    for (const version of [3, 4, 5]) {
      for (const id of ['g', 'm', 'f', 'i', 's']) {
        const value = containers(1);
        value.schemaVersion = version;
        for (const node of Object.values(value.nodes)) {
          if (version < 5) delete node.textOverrides;
          if (node.type === 'rectangle' || node.type === 'path') node.stroke = null;
        }
        value.nodes[id]!.opacity = 0.5;
        const at = { ok: false, code: 'document.invalid-field', path: `/nodes/${id}/opacity` };
        expect(validateAnyDocument(value), `v${version} ${id}`).toEqual(at);
        expect(validateDocument(value).ok).toBe(false);
        loadFails(value, 'document.invalid-field', `/nodes/${id}/opacity`);
      }
    }
    // Opacity is read before the v5 fill, so an older gradient behind it is not reached.
    const value = doc(
      { p: ['f'] },
      [frame('f', 'p', [], { opacity: 0.5, fill: { kind: 'x' } })],
      5,
    );
    expect(validateAnyDocument(value)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/f/opacity',
    });
  });

  it('still fails an older fragment at opacity 0.5 and pastes the same nodes at v6', () => {
    const setup = counted(doc({ p: [] }, []));
    const nodes = { g: group('g', '', ['k'], { opacity: 0.5 }), k: rect('k', 'g') };
    for (const schemaVersion of [3, 4, 5]) {
      fails(
        setup,
        {
          type: 'paste',
          text: fragment({
            fragmentVersion: 2,
            schemaVersion,
            roots: ['g'],
            nodes,
            sources: [],
            sourceNodes: {},
          }),
        },
        { code: 'document.invalid-field', path: '/nodes/g/opacity' },
      );
    }
    // The older-input rule comes after the fields read before opacity, as a v5 document reads.
    fails(
      setup,
      {
        type: 'paste',
        text: fragment({
          fragmentVersion: 2,
          schemaVersion: 5,
          roots: ['g'],
          nodes: { ...nodes, g: { ...nodes.g, name: 5 } },
          sources: [],
          sourceNodes: {},
        }),
      },
      { code: 'document.invalid-field', path: '/nodes/g/name' },
    );
    const [pasted] = ok(setup.target, {
      type: 'paste',
      text: fragment({
        fragmentVersion: 2,
        schemaVersion: 6,
        roots: ['g'],
        nodes,
        sources: [],
        sourceNodes: {},
      }),
    });
    expect(setup.target.query({ type: 'node', id: pasted! })).toMatchObject({ opacity: 0.5 });
    // The model's fragment tree rule at v6 accepts it too.
    expect(
      validateFragmentTree({
        schemaVersion: 6,
        id: 'h',
        pages: [{ id: 'hp', name: '', children: ['g'] }],
        nodes: { g: { ...nodes.g, parent: 'hp' }, k: nodes.k },
      }).ok,
    ).toBe(true);
  });

  it('sets 0, 0.5 and 1 on every container type and an instance through setNodeProps and setStyle', () => {
    for (const command of ['setNodeProps', 'setStyle'] as const) {
      const setup = counted(containers(1));
      for (const opacity of [0.5, 0, 1]) {
        for (const id of ['g', 'm', 'f', 'i', 's']) {
          // `setStyle` takes nodes of the active page; the source is on page q.
          const page = id === 's' ? 'q' : 'p';
          ok(setup.target, { type: 'setActivePage', id: page });
          ok(
            setup.target,
            command === 'setNodeProps'
              ? { type: 'setNodeProps', id, props: { opacity } }
              : { type: 'setStyle', ids: [id], style: { opacity } },
          );
          expect(setup.target.query({ type: 'node', id })).toMatchObject({ opacity });
        }
      }
      ok(setup.target, { type: 'setActivePage', id: 'p' });
      for (const opacity of [-0.1, 1.5, Number.NaN]) {
        fails(
          setup,
          command === 'setNodeProps'
            ? { type: 'setNodeProps', id: 'i', props: { opacity } }
            : { type: 'setStyle', ids: ['g', 'i'], style: { opacity } },
          {
            code: 'document.invalid-field',
            path: command === 'setNodeProps' ? '/nodes/i/opacity' : '/nodes/g/opacity',
          },
        );
      }
    }
  });

  it('accepts container opacity in validateNode, and the older-input option keeps M4-M2', () => {
    const node = frame('f', 'p', [], { opacity: 0.5 });
    expect(validateNode(node).ok).toBe(true);
    expect(validateNode(node, { olderInput: true })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/opacity',
    });
    // A leaf's opacity is any in [0, 1] in either case.
    expect(validateNode(rect('r', 'p', { opacity: 0.5 }), { olderInput: true }).ok).toBe(true);
  });
});

describe('M4-A08 and M4-A10 effective opacity, instance × source (M4-P6, M4-Q15 (a))', () => {
  const symbols = (instanceOpacity: number, sourceOpacity: number) =>
    parsed(
      doc({ p: ['i', 'j'], q: ['s'] }, [
        instance('i', 'p', 's', { opacity: instanceOpacity }),
        instance('j', 'p', 's', {
          opacity: instanceOpacity,
          frame: { x: 0, y: 100, width: 200, height: 100 },
        }),
        symbol('s', 'q', ['s-r'], { opacity: sourceOpacity, fill: red }),
        rect('s-r', 's', { opacity: 0.5 }),
      ]),
    );

  it('projects the outer container at instance × source, the content at 1', () => {
    for (const [own, source, product] of [
      [1, 1, 1],
      [0.5, 1, 0.5],
      [1, 0.5, 0.5],
      [0.5, 0.5, 0.25],
      [0, 0.5, 0],
      [0.5, 0, 0],
    ] as const) {
      const document = symbols(own, source);
      const nodes = project(document, 'p');
      for (const id of ['i', 'j']) {
        expect(containerOf(nodes, id).opacity, `${own} × ${source}`).toBe(product);
        expect(containerOf(nodes, `${id}\u0000content`).opacity).toBe(1);
        expect(effectiveOpacity(documentTree(document), document.nodes[id]!)).toBe(product);
      }
      // The source's own unit keeps its own opacity, and an expanded node its own.
      expect(containerOf(project(document, 'q'), 's').opacity).toBe(source);
      expect(nodes.get('i\u0000@s-r')).toMatchObject({ opacity: 0.5 });
    }
  });

  it('a source opacity edit reaches every instance projection, and undo restores it', () => {
    const setup = counted(JSON.parse(serializeDocument(symbols(1, 1))));
    ok(setup.target, { type: 'setNodeProps', id: 's', props: { opacity: 0.5 } });
    const after = project(setup.target.query({ type: 'document' }), 'p');
    expect(containerOf(after, 'i').opacity).toBe(0.5);
    expect(containerOf(after, 'j').opacity).toBe(0.5);
    ok(setup.target, { type: 'undo' });
    expect(containerOf(project(setup.target.query({ type: 'document' }), 'p'), 'i').opacity).toBe(
      1,
    );
  });

  type Leaf = Extract<RenderNodeSnapshot, { kind: 'primitive' | 'path' }>;
  /** The drawn leaves of a page in projection order, with their geometry and style. */
  const drawn = (document: DocumentV6, page: string) =>
    [...project(document, page).values()]
      .filter((node): node is Leaf => node.kind !== 'container')
      .map((node) => ({ kind: node.kind, geometry: node.geometry, style: node.style }));

  it('detach writes the effective opacity, keeping the projection (M7 section 5.2)', () => {
    for (const [own, source] of [
      [1, 0.5],
      [0.5, 0.5],
      [0.5, 1],
    ] as const) {
      const document = symbols(own, source);
      const before = project(document, 'p');
      const setup = counted(JSON.parse(serializeDocument(document)));
      ok(setup.target, { type: 'detachInstances', ids: ['i'] });
      const detached = setup.target.query({ type: 'document' });
      expect(detached.nodes.i).toMatchObject({ type: 'frame', opacity: own * source });
      const after = project(detached, 'p');
      // The outer container but its children, whose IDs are the copies' now.
      const outer = (nodes: typeof before) => ({ ...containerOf(nodes, 'i'), children: [] });
      expect(outer(after)).toEqual(outer(before));
      expect(drawn(detached, 'p')).toEqual(drawn(document, 'p'));
    }
  });

  it('the deletion rule detaches with the effective opacity', () => {
    const setup = counted(JSON.parse(serializeDocument(symbols(1, 0.5))));
    ok(setup.target, { type: 'setActivePage', id: 'q' });
    ok(setup.target, { type: 'deleteNodes', ids: ['s'] });
    const document = setup.target.query({ type: 'document' });
    expect(document.nodes.i).toMatchObject({ type: 'frame', opacity: 0.5 });
    expect(document.nodes.j).toMatchObject({ type: 'frame', opacity: 0.5 });
  });

  it('a pasted detached instance takes the effective opacity of its carried source', () => {
    const setup = counted(doc({ p: [] }, []));
    const [pasted] = ok(setup.target, {
      type: 'paste',
      text: fragment({
        fragmentVersion: 2,
        schemaVersion: 6,
        roots: ['i'],
        nodes: { i: instance('i', '', 's', { opacity: 0.5 }) },
        sources: ['s'],
        sourceNodes: {
          s: symbol('s', '', ['s-r'], { opacity: 0.5 }),
          's-r': rect('s-r', 's'),
        },
      }),
    });
    expect(setup.target.query({ type: 'node', id: pasted! })).toMatchObject({
      type: 'frame',
      opacity: 0.25,
    });
  });
});

describe('M4-A08 the isolation count (section 4.3)', () => {
  it('counts container ancestors below opacity 1, hidden and at opacity 0 included', () => {
    const document = parsed(
      doc({ p: ['a0'] }, [
        ...chain('a', 'p', 4, ['r'], 0.5, (level) =>
          level === 1
            ? { visible: false }
            : level === 2
              ? { opacity: 0 }
              : level === 3
                ? { opacity: 1 }
                : {},
        ),
        rect('r', 'a3'),
      ]),
    );
    const tree = documentTree(document);
    expect(['a0', 'a1', 'a2', 'a3', 'r'].map((id) => isolationCount(tree, id))).toEqual([
      0, 1, 2, 3, 3,
    ]);
  });

  it('passes a leaf at count 32 and fails one at 33 on load, at its parent', () => {
    loads(doc({ p: ['g0'] }, [...chain('g', 'p', 32, ['r']), rect('r', 'g31')]));
    loadFails(
      doc({ p: ['g0'] }, [...chain('g', 'p', 33, ['r']), rect('r', 'g32')]),
      'editor.isolation-depth',
      '/nodes/r/parent',
    );
    // Hidden and opacity-0 ancestors count the same.
    for (const extra of [{ visible: false }, { opacity: 0 }]) {
      loadFails(
        doc({ p: ['g0'] }, [
          ...chain('g', 'p', 33, ['r'], 0.5, (l) => (l === 7 ? extra : {})),
          rect('r', 'g32'),
        ]),
        'editor.isolation-depth',
        '/nodes/r/parent',
      );
    }
    // Containers at opacity 1 do not count.
    loads(
      doc({ p: ['g0'] }, [
        ...chain('g', 'p', 40, ['r'], 0.5, (level) => (level % 5 === 0 ? { opacity: 1 } : {})),
        rect('r', 'g39'),
      ]),
    );
  });

  it('fails a frame, symbol or instance below opacity 1 at count 32 even when empty', () => {
    // 32 nested groups at 0.5 around an empty frame at 0.5 fail; at opacity 1 it passes.
    loadFails(
      doc({ p: ['g0'] }, [...chain('g', 'p', 32, ['f']), frame('f', 'g31', [], { opacity: 0.5 })]),
      'editor.isolation-depth',
      '/nodes/f/parent',
    );
    loads(doc({ p: ['g0'] }, [...chain('g', 'p', 32, ['f']), frame('f', 'g31')]));
    loads(
      doc({ p: ['g0'] }, [...chain('g', 'p', 31, ['f']), frame('f', 'g30', [], { opacity: 0.5 })]),
    );
    loadFails(
      doc({ p: ['g0'] }, [...chain('g', 'p', 32, ['s']), symbol('s', 'g31', [], { opacity: 0.5 })]),
      'editor.isolation-depth',
      '/nodes/s/parent',
    );
    loads(doc({ p: ['g0'] }, [...chain('g', 'p', 32, ['s']), symbol('s', 'g31')]));
    // An instance by its own opacity, and by its effective opacity through a translucent source.
    const instanced = (own: number, source: number) =>
      doc({ p: ['g0'], q: ['s'] }, [
        ...chain('g', 'p', 32, ['i']),
        instance('i', 'g31', 's', { opacity: own }),
        symbol('s', 'q', [], { opacity: source }),
      ]);
    loadFails(instanced(0.5, 1), 'editor.isolation-depth', '/nodes/i/parent');
    loadFails(instanced(1, 0.5), 'editor.isolation-depth', '/nodes/i/parent');
    loads(instanced(1, 1));
  });

  it('counts through an expansion: the instance, then the containers inside its source', () => {
    // A source at 1 holding 32 groups at 0.5 around a rectangle: 32 on its page.
    const source = [symbol('s', 'q', ['h0']), ...chain('h', 's', 32, ['k']), rect('k', 'h31')];
    loads(doc({ p: ['i'], q: ['s'] }, [instance('i', 'p', 's'), ...source]));
    // An instance at 0.5 puts the expanded rectangle at 33, reported at the instance.
    loadFails(
      doc({ p: ['i'], q: ['s'] }, [instance('i', 'p', 's', { opacity: 0.5 }), ...source]),
      'editor.isolation-depth',
      '/nodes/i/parent',
    );
    // A frame at 0.5 inside the source at expanded count 32 fails through the instance too.
    const framed = [
      symbol('s', 'q', ['h0']),
      ...chain('h', 's', 31, ['e']),
      frame('e', 'h30', [], { opacity: 0.5 }),
    ];
    loads(doc({ p: ['i'], q: ['s'] }, [instance('i', 'p', 's'), ...framed]));
    loadFails(
      doc({ p: ['i'], q: ['s'] }, [instance('i', 'p', 's', { opacity: 0.5 }), ...framed]),
      'editor.isolation-depth',
      '/nodes/i/parent',
    );
    expect(
      documentIsolationViolation(
        parsed(doc({ p: ['i'], q: ['s'] }, [instance('i', 'p', 's', { opacity: 0.5 }), ...framed])),
      ),
    ).toBe('i');
  });

  it('reports the first failing node in pages order, then page-tree pre-order', () => {
    const value = doc({ p: ['a0', 'b0'], q: ['c0'] }, [
      ...chain('a', 'p', 33, ['ra']),
      rect('ra', 'a32'),
      ...chain('b', 'p', 33, ['rb']),
      rect('rb', 'b32'),
      ...chain('c', 'q', 33, ['rc']),
      rect('rc', 'c32'),
    ]);
    loadFails(value, 'editor.isolation-depth', '/nodes/ra/parent');
    value.pages = [value.pages[1]!, value.pages[0]!];
    loadFails(value, 'editor.isolation-depth', '/nodes/rc/parent');
  });

  describe('in commands', () => {
    it('an opacity edit through setNodeProps and setStyle', () => {
      const setup = counted(doc({ p: ['g0'] }, [...chain('g', 'p', 32, ['f']), frame('f', 'g31')]));
      for (const command of [
        { type: 'setNodeProps', id: 'f', props: { opacity: 0.5 } },
        { type: 'setStyle', ids: ['f'], style: { opacity: 0.5 } },
        { type: 'setStyle', ids: ['g3', 'f'], style: { opacity: 0 } },
      ] as const) {
        fails(setup, command, { code: 'editor.isolation-depth', path: '/nodes/f/parent' });
      }
      // Raising an opacity never fails, and an opacity below 1 changed again is not rechecked.
      ok(setup.target, { type: 'setNodeProps', id: 'g5', props: { opacity: 1 } });
      ok(setup.target, { type: 'setNodeProps', id: 'f', props: { opacity: 0.5 } });
      ok(setup.target, { type: 'setNodeProps', id: 'g6', props: { opacity: 0.25 } });
      fails(
        setup,
        { type: 'setNodeProps', id: 'g5', props: { opacity: 0.5 } },
        { code: 'editor.isolation-depth', path: '/nodes/f/parent' },
      );
    });

    it('an instance and a source opacity edit, through every instance of the source', () => {
      const value = doc({ p: ['g0'], q: ['s'] }, [
        ...chain('g', 'p', 32, ['i']),
        instance('i', 'g31', 's'),
        symbol('s', 'q', ['k']),
        rect('k', 's'),
      ]);
      const setup = counted(value);
      fails(
        setup,
        { type: 'setNodeProps', id: 'i', props: { opacity: 0.5 } },
        { code: 'editor.isolation-depth', path: '/nodes/i/parent' },
      );
      // The source itself sits at 0, but its instance becomes a translucent unit at 32.
      fails(
        setup,
        { type: 'setNodeProps', id: 's', props: { opacity: 0.5 } },
        { code: 'editor.isolation-depth', path: '/nodes/i/parent' },
      );
      ok(setup.target, { type: 'setActivePage', id: 'q' });
      fails(
        setup,
        { type: 'setStyle', ids: ['s'], style: { opacity: 0.5 } },
        { code: 'editor.isolation-depth', path: '/nodes/i/parent' },
      );
    });

    it('a node edited inside a source, through its instances', () => {
      const value = doc({ p: ['i'], q: ['s'] }, [
        instance('i', 'p', 's', { opacity: 0.5 }),
        symbol('s', 'q', ['h0']),
        ...chain('h', 's', 32, ['k'], 0.5, (level) => (level === 31 ? { opacity: 1 } : {})),
        rect('k', 'h31'),
      ]);
      const setup = counted(value);
      // On its page k sits at 31, in the instance at 1 + 31; at 0.5 its parent makes them 32
      // and 33.
      ok(setup.target, { type: 'setActivePage', id: 'q' });
      fails(
        setup,
        { type: 'setStyle', ids: ['h31'], style: { opacity: 0.5 } },
        { code: 'editor.isolation-depth', path: '/nodes/i/parent' },
      );
    });

    it('a reparent', () => {
      const value = doc({ p: ['g0', 'm'] }, [
        ...chain('g', 'p', 32, ['r']),
        rect('r', 'g31'),
        group('m', 'p', ['k'], { opacity: 0.5 }),
        rect('k', 'm'),
      ]);
      const setup = counted(value);
      fails(
        setup,
        { type: 'moveNodes', ids: ['m'], parent: 'g31', index: 0 },
        { code: 'editor.isolation-depth', path: '/nodes/k/parent' },
      );
      // One level up it fits (k at 32), and from there the move fails the same way.
      ok(setup.target, { type: 'moveNodes', ids: ['m'], parent: 'g30', index: 0 });
      fails(
        setup,
        { type: 'moveNodes', ids: ['m'], parent: 'g31', index: 0 },
        { code: 'editor.isolation-depth', path: '/nodes/k/parent' },
      );
    });

    it('a paste', () => {
      const value = doc({ p: ['g0'] }, [
        ...chain('g', 'p', 31, ['f']),
        frame('f', 'g30', [], { opacity: 0.5 }),
      ]);
      const setup = counted(value);
      ok(setup.target, { type: 'setSelection', ids: ['f'] });
      const body = (opacity: number) =>
        fragment({
          fragmentVersion: 2,
          schemaVersion: 6,
          roots: ['c'],
          nodes: { c: group('c', '', ['k'], { opacity }), k: rect('k', 'c') },
          sources: [],
          sourceNodes: {},
        });
      // The frame's children sit at 32: a group at 0.5 there puts its rectangle at 33.
      fails(
        setup,
        { type: 'paste', text: body(0.5) },
        {
          code: 'editor.isolation-depth',
          path: '/nodes/k/parent',
        },
      );
      ok(setup.target, { type: 'paste', text: body(1) });
    });

    it('a create, a new instance by its effective opacity', () => {
      const value = doc({ p: ['g0'], q: ['s'] }, [
        ...chain('g', 'p', 32, []).map((node, level) =>
          level === 31 ? { ...node, children: ['r'] } : node,
        ),
        rect('r', 'g31'),
        symbol('s', 'q', [], { opacity: 0.5 }),
      ]);
      const setup = counted(value);
      fails(
        setup,
        { type: 'createInstance', symbol: 's', parent: 'g31' },
        { code: 'editor.isolation-depth', path: '/parent' },
      );
      ok(setup.target, {
        type: 'createFrame',
        frame: { x: 0, y: 0, width: 10, height: 10 },
        parent: 'g31',
      });
      ok(setup.target, { type: 'setNodeProps', id: 's', props: { opacity: 1 } });
      ok(setup.target, { type: 'createInstance', symbol: 's', parent: 'g31' });
    });

    it('is stable under visibility edits', () => {
      const setup = counted(doc({ p: ['g0'] }, [...chain('g', 'p', 32, ['r']), rect('r', 'g31')]));
      ok(setup.target, { type: 'setStyle', ids: ['g0', 'g1'], style: { opacity: 0 } });
      ok(setup.target, { type: 'setNodeProps', id: 'g2', props: { visible: false } });
      ok(setup.target, { type: 'setNodeProps', id: 'g2', props: { visible: true } });
    });
  });

  describe('precedence (section 4.4)', () => {
    it('editor.clip-depth before editor.isolation-depth, on load', () => {
      // An isolation failure on the first page, a clip-depth failure (33 nested frames) on the
      // second: the clip depth is reported.
      const frames: Loose[] = [];
      for (let level = 0; level < 33; level += 1) {
        frames.push(
          frame(
            `f${level}`,
            level === 0 ? 'q' : `f${level - 1}`,
            level < 32 ? [`f${level + 1}`] : [],
          ),
        );
      }
      const value = doc({ p: ['g0'], q: ['f0'] }, [
        ...chain('g', 'p', 33, ['r']),
        rect('r', 'g32'),
        ...frames,
      ]);
      loadFails(value, 'editor.clip-depth', '/nodes/f32/parent');
      // Without the clip failure the isolation failure shows.
      frames[31]!.children = [];
      loadFails(
        doc({ p: ['g0'], q: ['f0'] }, [
          ...chain('g', 'p', 33, ['r']),
          rect('r', 'g32'),
          ...frames.slice(0, 32),
        ]),
        'editor.isolation-depth',
        '/nodes/r/parent',
      );
    });

    it('editor.clip-depth before editor.isolation-depth, in a command', () => {
      // 32 nested frames at 0.5 hold the innermost at clip depth and count 31: a frame at 0.5
      // moved into it breaks both rules at once.
      const frames: Loose[] = [];
      for (let level = 0; level < 32; level += 1) {
        frames.push(
          frame(
            `f${level}`,
            level === 0 ? 'p' : `f${level - 1}`,
            level < 31 ? [`f${level + 1}`] : [],
            {
              opacity: 0.5,
            },
          ),
        );
      }
      const setup = counted(
        doc({ p: ['f0', 'x'] }, [...frames, frame('x', 'p', [], { opacity: 0.5 })]),
      );
      fails(
        setup,
        { type: 'moveNodes', ids: ['x'], parent: 'f31', index: 0 },
        { code: 'editor.clip-depth', path: '/nodes/x/parent' },
      );
    });

    it('editor.isolation-depth before editor.invalid-expansion, on load and in a command', () => {
      // A source so narrow that an instance 100 wide overflows its expanded frames (M7-X3).
      const narrow = [
        symbol('s', 'q', ['k'], { frame: { x: 0, y: 0, width: 1e-305, height: 50 } }),
        rect('k', 's'),
      ];
      const invalid = instance('v', 'p', 's');
      loadFails(
        doc({ p: ['v'], q: ['s'] }, [invalid, ...narrow]),
        'editor.invalid-expansion',
        '/nodes/v',
      );
      loadFails(
        doc({ p: ['v', 'g0'], q: ['s'] }, [
          invalid,
          ...chain('g', 'p', 33, ['r']),
          rect('r', 'g32'),
          ...narrow,
        ]),
        'editor.isolation-depth',
        '/nodes/r/parent',
      );
      // A command: a new instance of the narrow source, translucent, at count 32.
      const value = doc({ p: ['g0'], q: ['s'] }, [
        ...chain('g', 'p', 32, ['r']),
        rect('r', 'g31'),
        ...narrow.map((node) => (node.id === 's' ? { ...node, opacity: 0.5 } : node)),
      ]);
      const setup = counted(value);
      const frame100 = { x: 0, y: 0, width: 100, height: 50 };
      fails(
        setup,
        { type: 'createInstance', symbol: 's', parent: 'g31', frame: frame100 },
        { code: 'editor.isolation-depth', path: '/parent' },
      );
      fails(
        setup,
        { type: 'createInstance', symbol: 's', parent: 'g0', frame: frame100 },
        // Relative to the new node, as every creating command reports it.
        { code: 'editor.invalid-expansion' },
      );
    });
  });
});

describe('M4-A09 setStyle (section 4.2)', () => {
  const dashed: Stroke = {
    color: red,
    width: 3,
    cap: 'round',
    join: 'bevel',
    miterLimit: 2,
    dash: { pattern: [4, 2], phase: 1 },
  };
  const mixed = () =>
    doc({ p: ['r', 'e', 'l', 'g', 'f', 'i', 't'], q: ['s'] }, [
      rect('r', 'p', { stroke: dashed }),
      base('e', 'p', { type: 'ellipse', fill: null, stroke: null }),
      base('l', 'p', {
        type: 'line',
        frame: { x: 0, y: 0, width: 100, height: 0 },
        points: [0, 0, 1, 0],
        stroke: null,
        startArrow: 'none',
        endArrow: 'none',
      }),
      group('g', 'p', ['g-r']),
      rect('g-r', 'g'),
      frame('f', 'p'),
      instance('i', 'p', 's'),
      base('t', 'p', {
        type: 'text',
        runs: [{ text: 'A', family: 'Inter', size: 12, color: black }],
        sizing: 'fixed',
        align: 'left',
        letterSpacing: 0,
        lineHeight: 1.2,
      }),
      symbol('s', 'q'),
    ]);

  it('sets each key on the listed nodes with that prop and skips the rest', () => {
    const setup = counted(mixed());
    const before = setup.target.query({ type: 'document' });
    expect(
      setup.target.execute({
        type: 'setStyle',
        ids: ['r', 'e', 'l', 'g', 'f', 'i', 't'],
        style: { fill: red, stroke: { width: 5 }, opacity: 0.5, cornerRadii: [1, 2, 3, 4] },
      }),
    ).toEqual({ ok: true, ids: [] });
    const after = setup.target.query({ type: 'document' });
    expect(after.nodes.r).toEqual({
      ...before.nodes.r,
      fill: red,
      stroke: { ...dashed, width: 5 },
      opacity: 0.5,
      cornerRadii: [1, 2, 3, 4],
    });
    // A patch over each default: the shape stroke on an ellipse or frame, the path stroke on a
    // line.
    expect(after.nodes.e).toEqual({
      ...before.nodes.e,
      fill: red,
      stroke: { ...DEFAULT_SHAPE_STROKE, width: 5 },
      opacity: 0.5,
    });
    expect(after.nodes.f).toEqual({
      ...before.nodes.f,
      fill: red,
      stroke: { ...DEFAULT_SHAPE_STROKE, width: 5 },
      opacity: 0.5,
    });
    expect(after.nodes.l).toEqual({
      ...before.nodes.l,
      stroke: { ...DEFAULT_PATH_STROKE, width: 5 },
      opacity: 0.5,
    });
    // A group, an instance and a text node take only the opacity.
    for (const id of ['g', 'i', 't']) {
      expect(after.nodes[id]).toEqual({ ...before.nodes[id], opacity: 0.5 });
    }
    expect(after.nodes['g-r']).toBe(before.nodes['g-r']);
    expect(setup.target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('removes a stroke with null and writes literal documents', () => {
    const setup = counted(mixed());
    ok(setup.target, { type: 'setStyle', ids: ['r', 'g'], style: { stroke: null } });
    const document = setup.target.query({ type: 'document' });
    expect(document.nodes.r).toMatchObject({ stroke: null });
    const expected = JSON.parse(serializeDocument(parsed(mixed()))) as Json;
    expected.nodes.r!.stroke = null;
    expect(text(setup.target)).toBe(serializeDocument(parsed(expected)));
    // A gradient fill and a full stroke patch.
    const gradient = {
      kind: 'radial',
      transform: [0.5, 0, 0, 0.5, 0.5, 0.5],
      stops: [
        { offset: 0, color: red },
        { offset: 1, color: clear },
      ],
      spread: 'reflect',
    } as const;
    ok(setup.target, { type: 'setStyle', ids: ['e'], style: { fill: gradient, stroke: dashed } });
    expected.nodes.e!.fill = gradient;
    expected.nodes.e!.stroke = dashed;
    expect(text(setup.target)).toBe(serializeDocument(parsed(expected)));
  });

  it('runs each check of section 4.2 in order with nothing changed', () => {
    const setup = counted(mixed());
    const invalid = (path: string) => ({ code: 'editor.invalid-command', path });
    const run = (command: unknown, failure: { code: string; path?: string }) =>
      fails(setup, command as Command, failure);
    run({ type: 'setStyle', ids: [], style: { opacity: 1 } }, invalid('/ids'));
    run({ type: 'setStyle', ids: ['r', 'r'], style: { opacity: 1 } }, invalid('/ids'));
    run({ type: 'setStyle', ids: [5], style: { opacity: 1 } }, invalid('/ids'));
    run({ type: 'setStyle', ids: 'r', style: { opacity: 1 } }, invalid('/ids'));
    // Unknown, and on another page than the active one.
    run({ type: 'setStyle', ids: ['r', 'nope'], style: null }, { code: 'editor.unknown-node' });
    run({ type: 'setStyle', ids: ['s'], style: { opacity: 1 } }, { code: 'editor.unknown-node' });
    run({ type: 'setStyle', ids: ['r'], style: null }, invalid('/style'));
    run({ type: 'setStyle', ids: ['r'], style: [] }, invalid('/style'));
    run({ type: 'setStyle', ids: ['r'], style: {} }, invalid('/style'));
    run({ type: 'setStyle', ids: ['g'], style: { fill: red, name: 'x' } }, invalid('/style/name'));
    run({ type: 'setStyle', ids: ['g'], style: { fill: red, 'a/b': 1 } }, invalid('/style/a~1b'));
    run(
      { type: 'setStyle', ids: ['g', 'i'], style: { fill: red, stroke: 5 } },
      invalid('/style/fill'),
    );
    run(
      { type: 'setStyle', ids: ['g', 'r'], style: { cornerRadii: [1, 1, 1, 1], stroke: 5 } },
      invalid('/style/stroke'),
    );
    run(
      { type: 'setStyle', ids: ['r'], style: { stroke: { width: 1, gap: 2 } } },
      invalid('/style/stroke/gap'),
    );
    run({ type: 'setStyle', ids: ['r'], style: { stroke: [] } }, invalid('/style/stroke'));
    // The merged nodes in `ids` order, at the model's paths.
    run(
      { type: 'setStyle', ids: ['e', 'r'], style: { stroke: { width: -1 } } },
      { code: 'document.invalid-field', path: '/nodes/e/stroke/width' },
    );
    run(
      { type: 'setStyle', ids: ['r', 'e'], style: { stroke: { width: -1 } } },
      { code: 'document.invalid-field', path: '/nodes/r/stroke/width' },
    );
    run(
      { type: 'setStyle', ids: ['r'], style: { stroke: { color: { r: 0, g: 0, b: 0 } } } },
      { code: 'document.invalid-field', path: '/nodes/r/stroke/color' },
    );
    run(
      { type: 'setStyle', ids: ['r'], style: { cornerRadii: [1, 1, 1] } },
      { code: 'document.invalid-field', path: '/nodes/r/cornerRadii' },
    );
  });

  it('runs the extension check on custom nodes', () => {
    const setup = counted(
      doc({ p: ['c'] }, [
        base('c', 'p', {
          type: 'custom',
          customType: 'ext.star',
          data: { points: 5, innerRatio: 0.5 },
          fill: null,
          stroke: null,
        }),
      ]),
    );
    ok(setup.target, { type: 'setStyle', ids: ['c'], style: { fill: red, stroke: {} } });
    expect(setup.target.query({ type: 'node', id: 'c' })).toMatchObject({
      fill: red,
      stroke: DEFAULT_PATH_STROKE,
    });
  });

  it('records no step and no event when no value changes', () => {
    const setup = counted(mixed());
    const document = setup.target.query({ type: 'document' });
    const revision = setup.target.query({ type: 'revision' });
    const styles: StyleProps[] = [
      { opacity: 1 },
      { fill: black, cornerRadii: [0, 0, 0, 0] },
      { stroke: { width: 3 } },
      { stroke: dashed },
    ];
    for (const style of styles) {
      expect(setup.target.execute({ type: 'setStyle', ids: ['r', 'g'], style })).toEqual({
        ok: true,
        ids: [],
      });
      expect(setup.target.query({ type: 'document' })).toBe(document);
    }
    expect(setup.target.query({ type: 'revision' })).toBe(revision);
    expect(setup.target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('is one undo step with byte-identical undo and redo, as is widened setNodeProps', () => {
    for (const command of [
      {
        type: 'setStyle',
        ids: ['r', 'e', 'g', 'i'],
        style: { opacity: 0.25, stroke: { width: 9 } },
      },
      { type: 'setNodeProps', id: 'g', props: { opacity: 0.25 } },
      { type: 'setNodeProps', id: 'i', props: { opacity: 0 } },
    ] as const) {
      const setup = counted(mixed());
      const before = text(setup.target);
      ok(setup.target, command);
      const after = text(setup.target);
      expect(after).not.toBe(before);
      expect(setup.target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
      ok(setup.target, { type: 'undo' });
      expect(text(setup.target)).toBe(before);
      ok(setup.target, { type: 'redo' });
      expect(text(setup.target)).toBe(after);
    }
  });
});

describe('M4-A11 hit testing unchanged (section 6)', () => {
  const linear = {
    kind: 'linear',
    transform: [1, 0, 0, 1, 0, 0],
    stops: [
      { offset: 0, color: clear },
      { offset: 1, color: clear },
    ],
    spread: 'pad',
  } as const;
  const document = () =>
    parsed(
      doc({ p: ['dash', 'stop', 'zero', 'miter'] }, [
        // A dashed stroke only: the gap at x = 15 on the top edge is hit as the dash is.
        rect('dash', 'p', {
          frame: { x: 0, y: 0, width: 100, height: 50 },
          fill: null,
          stroke: { ...DEFAULT_SHAPE_STROKE, width: 4, dash: { pattern: [10, 10], phase: 0 } },
        }),
        // A transparent gradient fill is hit inside.
        rect('stop', 'p', { frame: { x: 200, y: 0, width: 100, height: 50 }, fill: linear }),
        // Opacity 0 is hit.
        rect('zero', 'p', { frame: { x: 400, y: 0, width: 100, height: 50 }, opacity: 0 }),
        // A miter tip beyond w/2 is not hit: an open path's sharp corner.
        base('miter', 'p', {
          type: 'path',
          frame: { x: 600, y: 0, width: 100, height: 100 },
          path: {
            verbs: ['move', 'line', 'line'],
            points: [0, 1, 0.5, 0, 1, 1],
            fillRule: 'nonzero',
          },
          fill: null,
          stroke: { ...DEFAULT_PATH_STROKE, width: 20, join: 'miter', miterLimit: 10 },
        }),
      ]),
    );
  const hit = (x: number, y: number) => deepestHit(document(), 'p', { x, y }, 1, custom);

  it('hits a dash gap, a transparent stop and opacity 0, and not a miter tip', () => {
    expect(hit(5, 0)).toBe('dash');
    expect(hit(15, 0)).toBe('dash');
    expect(hit(50, 25)).toBeNull();
    expect(hit(250, 25)).toBe('stop');
    expect(hit(450, 25)).toBe('zero');
    // The apex at (650, 0): within w/2 = 10 of the outline it hits, the miter tip above does not.
    expect(hit(650, -5)).toBe('miter');
    expect(hit(650, -15)).toBeNull();
  });
});
