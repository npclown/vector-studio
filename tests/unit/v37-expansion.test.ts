// V-37 U2 (docs/plans/viz-v37-variants-overrides-contract.md, section 3 and the detach bullet of
// 4.2): the override step of the expansion, its cache key, key upkeep, detach and the projection
// and SVG export of an overridden instance (V37-A03, A04, A05, A09, A11).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateDocument, type DocumentV8, type InstanceNodeV8 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  createCounterIdSource,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import { Draft } from '../../packages/editor-core/src/draft.js';
import {
  ExpansionCache,
  MAX_EXPANDED_NODES,
  expandInstance,
  expansionFailure,
} from '../../packages/editor-core/src/expansion.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- fixtures are edited as untyped JSON */
type Json = Record<string, any>;
const GOOD = readFileSync(
  path.resolve(import.meta.dirname, '../fixtures/v37-variants/variants.v8.json'),
  'utf8',
);
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const PURPLE = { r: 0.5, g: 0, b: 0.5, a: 1 };

/** The variants fixture after `edit`, read by the model. */
function build(edit: (value: Json) => void = () => {}): DocumentV8 {
  const value = JSON.parse(GOOD) as Json;
  edit(value);
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}
const instanceOf = (document: DocumentV8) => document.nodes.inst1 as InstanceNodeV8;
const withOverrides = (
  document: DocumentV8,
  overrides: InstanceNodeV8['overrides'],
): DocumentV8 => {
  const rest: Record<string, unknown> = { ...instanceOf(document) };
  delete rest.overrides;
  return {
    ...document,
    nodes: {
      ...document.nodes,
      inst1: (overrides === undefined ? rest : { ...rest, overrides }) as InstanceNodeV8,
    },
  };
};
function expanded(document: DocumentV8, id = 'inst1') {
  const result = expandInstance(document, id);
  if (result === null || !result.ok) throw new Error('no expansion');
  return result.expansion;
}
const editorOf = (document: DocumentV8): Editor =>
  createEditor({ document, ids: createCounterIdSource('n') });

const noCustom = () => null;

describe('V37-A03 the override step (V37-X1)', () => {
  it('equals the source copy with the override fields applied, text runs kept', () => {
    const document = build();
    const expansion = expanded(document);
    const source = document.nodes;
    expect(expansion.nodes.get('r1')).toEqual({
      ...source.r1,
      ...(instanceOf(document).overrides!.r1 as object),
    });
    expect(expansion.nodes.get('t1')).toEqual({
      ...source.t1,
      runs: instanceOf(document).textOverrides.t1!.runs,
      opacity: 0.25,
      effects: [{ kind: 'layerBlur', visible: true, radius: 2 }],
    });
    // Fields the override leaves out stay the source's.
    expect(expansion.nodes.get('r1')).toMatchObject({
      frame: source.r1!.frame,
      cornerRadii: [0, 0, 0, 0],
    });
  });

  it('equals the v7 output with no overrides: the source objects themselves', () => {
    const document = withOverrides(build(), undefined);
    const bare = { ...document, nodes: { ...document.nodes } } as DocumentV8;
    const expansion = expanded(bare);
    expect(expansion.nodes.get('r1')).toBe(bare.nodes.r1);
    // Only an overridden node is a new object.
    const partial = withOverrides(document, { t1: { opacity: 0.5 } });
    const result = expanded(partial);
    expect(result.nodes.get('r1')).toBe(partial.nodes.r1);
    expect(result.nodes.get('t1')).not.toBe(partial.nodes.t1);
  });

  it('applies before the scale map: an overridden node scales like any other', () => {
    const document = build((value) => {
      value.nodes.inst1.frame.width = 200;
      value.nodes.inst1.frame.height = 80;
    });
    const expansion = expanded(document);
    const r1 = expansion.nodes.get('r1')!;
    expect(r1.frame.width).toBe(100);
    expect(r1.frame.height).toBe(80);
    expect(r1).toMatchObject({ fill: GREEN, opacity: 0.5, visible: false });
  });

  it('fails the expansion when an overridden node fails the field rules (V37-X3)', () => {
    // A hand-built document that skips the model: a fill on a text node is ignored, an opacity
    // outside [0, 1] fails the node.
    const document = withOverrides(build(), { r1: { opacity: 5 } });
    const result = expandInstance(document, 'inst1');
    expect(result).toMatchObject({ ok: false, code: 'editor.invalid-expansion', node: 'r1' });
    const ignored = withOverrides(build(), { t1: { fill: GREEN } });
    expect(expandInstance(ignored, 'inst1')!.ok).toBe(true);
    expect('fill' in expanded(ignored).nodes.get('t1')!).toBe(false);
  });
});

describe('V37-A04 source edits propagate to fields without an override', () => {
  it('keeps an overridden field and follows the source on the others', () => {
    const target = editorOf(
      build((value) => {
        value.nodes.inst1.overrides = { r1: { fill: GREEN } };
      }),
    );
    const stroke = {
      color: PURPLE,
      width: 3,
      cap: 'butt' as const,
      join: 'miter' as const,
      miterLimit: 4,
      dash: null,
    };
    expect(
      target.execute({ type: 'setNodeProps', id: 'r1', props: { stroke, fill: PURPLE } }).ok,
    ).toBe(true);
    const document = target.query({ type: 'document' });
    const r1 = expanded(document).nodes.get('r1')!;
    expect(r1).toMatchObject({ fill: GREEN, stroke });
    expect(target.execute({ type: 'setNodeProps', id: 'r1', props: { opacity: 0.4 } }).ok).toBe(
      true,
    );
    expect(expanded(target.query({ type: 'document' })).nodes.get('r1')).toMatchObject({
      fill: GREEN,
      opacity: 0.4,
    });
  });

  it('takes the source key override for the instance background and border', () => {
    const document = build();
    const dump = (value: DocumentV8) =>
      JSON.stringify(
        [...projectPage(value, 'page-1', noCustom).nodes.values()].filter((n) =>
          n.id.startsWith('inst1'),
        ),
      );
    // The fixture's `sA` override is `fill: null`, so no red background; the source is red.
    const bare = withOverrides(document, { t1: { opacity: 1 } });
    expect(dump(bare)).toContain('"r":1,"g":0,"b":0');
    expect(dump(document)).not.toBe(dump(bare));
    const purple = withOverrides(document, { sA: { fill: PURPLE } });
    expect(dump(purple)).toContain('"r":0.5,"g":0,"b":0.5');
  });
});

describe('V37-A05 the cache key (V37-X2)', () => {
  it('recomputes only the child subtrees whose overrides changed, compared by value', () => {
    const base = build();
    const cache = new ExpansionCache();
    const first = cache.expand(base, 'inst1');
    expect(first!.ok).toBe(true);
    expect(cache.computed).toBe(2);
    // The same overrides in fresh objects: the instance node is new, every subtree is reused.
    const equal = withOverrides(base, structuredClone(instanceOf(base).overrides));
    cache.expand(equal, 'inst1');
    expect(cache.computed).toBe(2);
    // One child's override changes: that subtree only.
    const changed = withOverrides(base, {
      ...instanceOf(base).overrides,
      r1: { ...instanceOf(base).overrides!.r1, opacity: 0.9 },
    });
    const second = cache.expand(changed, 'inst1');
    expect(cache.computed).toBe(3);
    const nodes = (result: typeof first) => (result?.ok ? result.expansion.nodes : new Map());
    expect(nodes(second).get('t1')).toBe(nodes(first).get('t1'));
    expect(nodes(second).get('r1')).not.toBe(nodes(first).get('r1'));
    // An override removed: that subtree again; an override added to the other one likewise.
    const removed = withOverrides(changed, { t1: instanceOf(base).overrides!.t1! });
    cache.expand(removed, 'inst1');
    expect(cache.computed).toBe(4);
    // The source-key override is no child: it recomputes no subtree.
    const source = withOverrides(removed, {
      ...instanceOf(removed).overrides,
      sA: { fill: PURPLE },
    });
    const third = cache.expand(source, 'inst1');
    expect(cache.computed).toBe(4);
    expect(third).not.toBe(cache.expand(removed, 'inst1'));
  });
});

describe('V37-X4 key upkeep', () => {
  const run = (target: Editor, command: Parameters<Editor['execute']>[0]) => {
    const result = target.execute(command);
    if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
    return target.query({ type: 'document' });
  };

  it('drops the key of a node that leaves the source, and the map when empty', () => {
    const target = editorOf(
      build((value) => {
        value.nodes.inst1.overrides = { r1: { fill: GREEN }, t1: { opacity: 0.5 } };
      }),
    );
    const document = run(target, { type: 'deleteNodes', ids: ['r1'] });
    expect(instanceOf(document).overrides).toEqual({ t1: { opacity: 0.5 } });
    const emptied = run(target, { type: 'deleteNodes', ids: ['t1'] });
    expect(Object.hasOwn(instanceOf(emptied), 'overrides')).toBe(false);
    expect(validateDocument(JSON.parse(JSON.stringify(emptied))).ok).toBe(true);
    expect(run(target, { type: 'undo' }).nodes.inst1).toEqual(document.nodes.inst1);
  });

  it('drops the key of a node moved out of the source', () => {
    const target = editorOf(
      build((value) => {
        value.nodes.inst1.overrides = { r1: { fill: GREEN, opacity: 0.5 } };
      }),
    );
    const moved = run(target, { type: 'moveNodes', ids: ['r1'], parent: 'page-1', index: 3 });
    expect(Object.hasOwn(instanceOf(moved), 'overrides')).toBe(false);
  });

  /** The draft after retyping `r1` to a line, which has a stroke and no fill. */
  const retyped = (overrides: Json): DocumentV8 => {
    const document = build((value) => {
      value.nodes.inst1.overrides = overrides;
    });
    const draft = new Draft(document);
    const r1 = document.nodes.r1!;
    draft.set({
      id: 'r1',
      name: r1.name,
      parent: r1.parent,
      frame: r1.frame,
      rotation: 0,
      constraints: r1.constraints,
      opacity: 1,
      visible: true,
      type: 'line',
      points: [0, 0, 1, 1],
      stroke: null,
      startArrow: 'none',
      endArrow: 'none',
      effects: [],
    });
    const result = draft.finish(() => null, { refit: false });
    if ('ok' in result) throw new Error(result.code);
    return result;
  };

  it('drops a field that no longer applies after a type change, keeping the rest', () => {
    const stroke = {
      color: PURPLE,
      width: 2,
      cap: 'butt',
      join: 'round',
      miterLimit: 4,
      dash: null,
    };
    const kept = retyped({ r1: { fill: GREEN, stroke, opacity: 0.5 } });
    expect(instanceOf(kept).overrides).toEqual({ r1: { stroke, opacity: 0.5 } });
    expect(validateDocument(JSON.parse(JSON.stringify(kept))).ok).toBe(true);
  });

  it('removes an override left empty, and the map when none is left', () => {
    const two = retyped({ r1: { fill: GREEN }, t1: { opacity: 0.5 } });
    expect(instanceOf(two).overrides).toEqual({ t1: { opacity: 0.5 } });
    const none = retyped({ r1: { fill: GREEN } });
    expect(Object.hasOwn(instanceOf(none), 'overrides')).toBe(false);
    expect(validateDocument(JSON.parse(JSON.stringify(none))).ok).toBe(true);
  });
});

describe('V37-A09 detach bakes the overrides', () => {
  it('keeps every override in the frame and its children, and the source-key fill', () => {
    const target = editorOf(build());
    const before = target.query({ type: 'exportSvg', ids: ['inst1'] });
    const result = target.execute({ type: 'detachInstances', ids: ['inst1'] });
    expect(result.ok).toBe(true);
    const document = target.query({ type: 'document' });
    const frame = document.nodes.inst1!;
    expect(frame.type).toBe('frame');
    // The source-key override `fill: null` replaces the source's red background.
    expect(frame).toMatchObject({ fill: null });
    const [first, second] = (frame as unknown as { children: string[] }).children.map(
      (id) => document.nodes[id]!,
    );
    expect(first).toMatchObject({ fill: GREEN, opacity: 0.5, visible: false });
    expect(second).toMatchObject({ opacity: 0.25 });
    expect(target.query({ type: 'exportSvg', ids: ['inst1'] })).toBe(before);
  });

  it('projects the detached frame as the instance did, scene IDs mapped', () => {
    const open = build((value) => {
      value.nodes.inst1.overrides = {
        r1: { fill: GREEN, opacity: 0.5 },
        t1: { opacity: 0.25 },
        sA: { fill: PURPLE },
      };
    });
    const dump = (document: DocumentV8) => {
      const nodes = projectPage(document, 'page-1', noCustom).nodes;
      const mine = [nodes.get('inst1')!];
      for (const node of nodes.values()) {
        if (mine.some((held) => held.id === node.parentId)) mine.push(node);
      }
      // Scene IDs differ between the instance's expansion and the frame's children, so each is
      // named by its place in paint order.
      const names = new Map(mine.map((n, i) => [n.id, `#${i}`] as const));
      return JSON.stringify(mine, (key, value) =>
        key === 'id' || key === 'parentId' || key === 'children'
          ? Array.isArray(value)
            ? value.map((v) => names.get(v) ?? v)
            : (names.get(value) ?? value)
          : value,
      );
    };
    const target = editorOf(open);
    const before = dump(target.query({ type: 'document' }));
    expect(target.execute({ type: 'detachInstances', ids: ['inst1'] }).ok).toBe(true);
    const after = dump(target.query({ type: 'document' }));
    expect(after).toBe(before);
    expect(after).toContain('"g":1');
  });

  it('bakes them into a detached paste too, with the source-key stroke', () => {
    const source = editorOf(
      build((value) => {
        value.nodes.inst1.overrides.sA = {
          stroke: {
            color: PURPLE,
            width: 2,
            cap: 'butt',
            join: 'round',
            miterLimit: 4,
            dash: null,
          },
        };
      }),
    );
    expect(source.execute({ type: 'copy', ids: ['inst1'] }).ok).toBe(true);
    const text = source.query({ type: 'clipboard' })!;
    const fresh = createEditor({ ids: createCounterIdSource('p') });
    const pasted = fresh.execute({ type: 'paste', text });
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    const document = fresh.query({ type: 'document' });
    const frame = document.nodes[pasted.ids[0]!]! as unknown as {
      type: string;
      stroke: { color: unknown };
      children: string[];
    };
    expect(frame.type).toBe('frame');
    expect(frame.stroke.color).toEqual(PURPLE);
    expect(document.nodes[frame.children[0]!]).toMatchObject({
      fill: GREEN,
      opacity: 0.5,
      visible: false,
    });
    expect(validateDocument(JSON.parse(JSON.stringify(document))).ok).toBe(true);
  });
});

describe('V37-A11 projection and SVG export show the overrides', () => {
  it('projects the overridden paint, and a hidden node as not visible', () => {
    const document = build((value) => {
      value.nodes.inst1.overrides = { r1: { fill: GREEN, visible: false } };
    });
    const snapshot = (value: DocumentV8) => {
      const nodes = projectPage(value, 'page-1', noCustom).nodes;
      const id = [...nodes.keys()].find((key) => key.startsWith('inst1') && key.endsWith('r1'))!;
      return nodes.get(id)!;
    };
    expect(JSON.stringify(snapshot(document))).toContain('"g":1');
    expect(snapshot(document).visible).toBe(false);
    const plain = withOverrides(document, undefined);
    expect(JSON.stringify(snapshot(plain))).not.toContain('"g":1');
    expect(snapshot(plain).visible).toBe(true);
  });

  it('writes the override fill, stroke and opacity into the SVG', () => {
    const target = editorOf(
      build((value) => {
        value.nodes.inst1.overrides = { r1: { fill: GREEN, opacity: 0.5, stroke: null } };
      }),
    );
    const svg = target.query({ type: 'exportSvg', ids: ['inst1'] })!;
    expect(svg).toContain('#00ff00');
    const bare = editorOf(withOverrides(build(), undefined));
    expect(bare.query({ type: 'exportSvg', ids: ['inst1'] })).not.toContain('#00ff00');
  });
});

describe('V37-B1 the expansion cap counts what overrides add', () => {
  it('counts a background or border an override gives a null-painted source', () => {
    // 99 rectangles: one instance adds 101 scene nodes; 990 of them stay at 99,990 of 100,000.
    const value = JSON.parse(GOOD) as Json;
    const nodes: Json = { set1: undefined };
    const rect = (id: string, parent: string) => ({
      ...value.nodes.r1,
      id,
      parent,
    });
    const children = Array.from({ length: 99 }, (_, i) => `q${i}`);
    nodes.src = {
      ...value.nodes.sP,
      id: 'src',
      parent: 'page-1',
      children,
      frame: { x: 0, y: 0, width: 10, height: 10 },
    };
    for (const id of children) nodes[id] = rect(id, 'src');
    delete nodes.set1;
    const ids = Array.from({ length: 990 }, (_, i) => `i${i}`);
    for (const id of ids) {
      nodes[id] = {
        ...value.nodes.inst1,
        id,
        symbol: 'src',
        textOverrides: {},
        overrides: undefined,
      };
      delete nodes[id].overrides;
    }
    const make = (overrides: unknown) => {
      const copy = structuredClone(nodes);
      if (overrides !== undefined) for (const id of ids) copy[id].overrides = overrides;
      const result = validateDocument({
        schemaVersion: 8,
        id: 'cap',
        pages: [{ id: 'page-1', name: 'P', children: ['src', ...ids] }],
        nodes: copy,
      });
      if (!result.ok) throw new Error(`${result.code} ${result.path}`);
      return result.document;
    };
    expect(expansionFailure(make(undefined), new ExpansionCache())).toBeNull();
    expect(expansionFailure(make({ src: { stroke: null } }), new ExpansionCache())).toBeNull();
    const failure = expansionFailure(make({ src: { fill: GREEN } }), new ExpansionCache());
    expect(failure).toMatchObject({ ok: false, code: 'editor.expansion-limit' });
    expect(MAX_EXPANDED_NODES).toBe(100_000);
  });
});
