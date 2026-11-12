import { createCounterIdSource, createEditor } from '@vector-studio/editor-core';
import {
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type ColorStyle,
  type DocumentV8,
  type NodeV8,
  type VariableSet,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), V39-A01: the model reads,
// validates (S1 to S6, in order) and writes (S7) colour styles, variables and bindings.

const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };

/** A v8 document with rectangle `n1` (red fill, a stroke of width 2) and text `n2`. */
function base(): DocumentV8 {
  const editor = createEditor({ ids: createCounterIdSource('x') });
  const created = editor.execute({
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 10, height: 10 },
    fill: red,
  });
  const id = created.ok ? created.ids[0]! : '';
  editor.execute({ type: 'setStyle', ids: [id], style: { stroke: { color: blue, width: 2 } } });
  const original = editor.query({ type: 'document' });
  const rect = { ...original.nodes[id]!, id: 'n1' };
  const document = {
    ...original,
    pages: [{ ...original.pages[0]!, children: ['n1'] }],
    nodes: { n1: rect },
  };
  const text = {
    ...rect,
    id: 'n2',
    type: 'text',
    runs: [
      { text: 'a', family: 'Inter', size: 12, color: red },
      { text: 'b', family: 'Inter', size: 14, color: red },
    ],
    sizing: 'fixed',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
  } as unknown as Record<string, unknown>;
  delete text.cornerRadii;
  delete text.fill;
  delete text.stroke;
  const page = document.pages[0]!;
  return {
    ...document,
    pages: [{ ...page, children: [...page.children, 'n2'] }],
    nodes: { ...document.nodes, n2: text as unknown as NodeV8 },
  };
}

const styles: ColorStyle[] = [{ id: 's1', name: 'Brand/Red', paint: red }];
const variables: VariableSet = {
  modes: [
    { id: 'm1', name: 'Light' },
    { id: 'm2', name: 'Dark' },
  ],
  mode: 'm1',
  items: [
    { id: 'v1', name: 'Primary', type: 'color', values: { m1: red, m2: blue } },
    { id: 'v2', name: 'Opacity', type: 'number', values: { m1: 1, m2: 0.5 } },
  ],
};

function bound(patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const document = base();
  const rect = { ...document.nodes.n1!, bindings: { fill: { style: 's1' } } };
  const text = { ...document.nodes.n2!, bindings: { text: { variable: 'v1' } } };
  return {
    schemaVersion: 8,
    id: document.id,
    colorStyles: styles,
    variables,
    pages: document.pages,
    nodes: { ...document.nodes, n1: rect, n2: text },
    ...patch,
  };
}

function failure(value: unknown) {
  const result = validateDocument(value);
  return result.ok ? null : { code: result.code, path: result.path };
}

describe('V39-A01 the model', () => {
  it('reads tables and bindings, and a round trip is byte-identical', () => {
    const result = validateDocument(bound());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.colorStyles).toEqual(styles);
    expect(result.document.variables).toEqual(variables);
    expect(result.document.nodes.n1!.bindings).toEqual({ fill: { style: 's1' } });
    const text = serializeDocument(result.document);
    const again = parseDocument(text);
    expect(again.ok && serializeDocument(again.document)).toBe(text);
    // S7 order: tables after `id`, `bindings` last.
    const keys = Object.keys(JSON.parse(text) as object);
    expect(keys).toEqual(['schemaVersion', 'id', 'colorStyles', 'variables', 'pages', 'nodes']);
    const node = (JSON.parse(text) as { nodes: Record<string, object> }).nodes.n1!;
    expect(Object.keys(node).at(-1)).toBe('bindings');
  });

  it('documents without the fields stay as they were; older inputs gain none', () => {
    const plain = base();
    const result = validateDocument(plain);
    expect(result.ok && 'colorStyles' in result.document).toBe(false);
    expect(result.ok && 'variables' in result.document).toBe(false);
    const older = validateAnyDocument({ ...plain, schemaVersion: 7 });
    expect(older.ok && older.document.schemaVersion).toBe(8);
    // A v7 input has no such key.
    expect(validateAnyDocument({ ...plain, schemaVersion: 7, colorStyles: styles })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/colorStyles',
    });
  });

  it('checks shapes and limits of the tables (S1, S2, S3)', () => {
    expect(failure(bound({ colorStyles: [] }))).toMatchObject({ path: '/colorStyles' });
    expect(
      failure(bound({ colorStyles: [{ id: 's1', name: '', paint: red }] })),
    ).toMatchObject({ path: '/colorStyles/0/name' });
    expect(
      failure(bound({ variables: { ...variables, items: [] } })),
    ).toMatchObject({ path: '/variables/items' });
    const missing = { ...variables.items[0]!, values: { m1: red } };
    expect(
      failure(bound({ variables: { ...variables, items: [missing, variables.items[1]] } })),
    ).toMatchObject({ path: '/variables/items/0/values' });
    const modes = Array.from({ length: 17 }, (_, index) => ({ id: `x${index}`, name: 'M' }));
    expect(failure(bound({ variables: { ...variables, modes } }))).toMatchObject({
      path: '/variables/modes',
    });
  });

  it('IDs are unique across the document, pages, nodes and tables; mode names a mode', () => {
    expect(
      failure(bound({ colorStyles: [{ id: 'n1', name: 'X', paint: red }] })),
    ).toEqual({ code: 'document.duplicate-id', path: '/colorStyles/0/id' });
    expect(failure(bound({ variables: { ...variables, mode: 'm9' } }))).toEqual({
      code: 'document.dangling-reference',
      path: '/variables/mode',
    });
  });

  it('checks bindings: dangling, wrong type, mismatched value, range in every mode (S5, S6)', () => {
    const with_ = (id: string, bindings: unknown, extra: Record<string, unknown> = {}) => {
      const document = bound();
      const nodes = document.nodes as Record<string, Record<string, unknown>>;
      return {
        ...document,
        nodes: { ...nodes, [id]: { ...nodes[id], bindings, ...extra } },
      };
    };
    expect(failure(with_('n1', { fill: { style: 'zz' } }))).toEqual({
      code: 'document.dangling-reference',
      path: '/nodes/n1/bindings/fill',
    });
    expect(failure(with_('n1', { fill: { variable: 'v2' } }))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/n1/bindings/fill',
    });
    expect(failure(with_('n1', { stroke: { style: 's1' } }))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/n1/bindings/stroke',
    });
    expect(failure(with_('n1', { stroke: { variable: 'v1' } }, { stroke: null }))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/n1/bindings/stroke',
    });
    // Opacity 1 matches the active mode; both modes are in [0, 1].
    expect(failure(with_('n1', { opacity: { variable: 'v2' } }))).toBeNull();
    const wide = {
      ...variables,
      items: [variables.items[0]!, { ...variables.items[1]!, values: { m1: 1, m2: 2 } }],
    };
    expect(
      failure({ ...with_('n1', { opacity: { variable: 'v2' } }), variables: wide }),
    ).toEqual({ code: 'document.invalid-field', path: '/nodes/n1/bindings/opacity' });
    // The node rule: a key the type has no field for, an empty object, a bad reference shape.
    expect(failure(with_('n1', { text: { variable: 'v1' } }))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/n1/bindings/text',
    });
    expect(failure(with_('n1', {}))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/n1/bindings',
    });
    expect(failure(with_('n1', { fill: { style: 's1', variable: 'v1' } }))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/n1/bindings/fill',
    });
  });

  it('validateNode checks the binding shape by type only; fragments skip the tables', () => {
    const rect = { ...base().nodes.n1!, stroke: null, bindings: { stroke: { style: 's1' } } };
    expect(validateNode(rect).ok).toBe(true);
    expect(validateNode({ ...rect, bindings: { text: { style: 's1' } } })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/bindings/text',
    });
    const document = bound();
    const fragment = {
      schemaVersion: 8,
      id: 'f',
      pages: document.pages,
      nodes: document.nodes,
    };
    expect(validateFragmentTree(fragment).ok).toBe(true);
    expect(validateFragmentTree({ ...fragment, colorStyles: styles }).ok).toBe(false);
  });
});
