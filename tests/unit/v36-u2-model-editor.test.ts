import {
  migrateV7toV8,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateNode,
  type DocumentV7,
  type DocumentV8,
  type Effect,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type NodeV8,
} from '../../packages/editor-core/src/index.js';
import { sceneEffects } from '../../packages/editor-core/src/projector.js';
import { visualBounds } from '../../packages/editor-core/src/visual-bounds.js';
import {
  addEffectCommand,
  effectKindCommand,
  effectNotice,
  effectRows,
  kindOptions,
} from '../../packages/ui/src/effects-model.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// V-36 U2 (docs/plans/viz-v36-inner-shadow-background-blur-contract.md): the model kinds at v8
// (V36-A01), the projector and its `effectKinds` query (V36-S5, A02) and the commands (A08,
// section 6).

type Loose = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const INNER: Effect = {
  kind: 'innerShadow',
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 0,
  offsetY: 4,
  radius: 4,
};
const BACKDROP: Effect = { kind: 'backgroundBlur', visible: true, radius: 4 };
const SHADOW: Effect = { ...INNER, kind: 'dropShadow', radius: 8 };
const BLUR: Effect = { kind: 'layerBlur', visible: true, radius: 4 };

const rect = (effects: unknown): Loose => ({
  id: 'r',
  name: 'r',
  parent: 'p',
  frame: { x: 0, y: 0, width: 100, height: 50 },
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: black,
  stroke: null,
  effects,
});

const documentOf = (effects: unknown, schemaVersion = 8): Loose => ({
  schemaVersion,
  id: 'd',
  pages: [{ id: 'p', name: 'P', children: ['r'] }],
  nodes: { r: rect(effects) },
});

const refusal = (path: string) => ({ ok: false, code: 'document.invalid-field', path });
const pick = (result: { ok: boolean; code?: string; path?: string }) =>
  result.ok ? { ok: true } : { ok: false, code: result.code, path: result.path };

describe('V36-A01 the model kinds (V36-S1, S2)', () => {
  it('reads, validates and round-trips both kinds at v8, in key order', () => {
    const effects = [SHADOW, INNER, BLUR, BACKDROP, { ...INNER, visible: false, radius: 0 }];
    const value = documentOf(effects);
    const result = parseDocument(JSON.stringify(value));
    expect(result.ok).toBe(true);
    const document = (result as { document: DocumentV8 }).document;
    expect(document.nodes.r!.effects).toEqual(effects);
    expect(validateDocument(value).ok).toBe(true);
    expect(validateAnyDocument(value).ok).toBe(true);
    const text = serializeDocument(document);
    expect(text).toContain(
      '"kind": "innerShadow",\n          "visible": true,\n          "color": {',
    );
    expect(text).toContain(
      '"kind": "backgroundBlur",\n          "visible": true,\n          "radius": 4\n',
    );
    expect(serializeDocument((parseDocument(text) as { document: DocumentV8 }).document)).toBe(
      text,
    );
  });

  it.each([
    ['a second background blur', [BACKDROP, INNER, BACKDROP], '/nodes/r/effects/2'],
    [
      'a shadow key on a background blur',
      [{ ...BACKDROP, color: black }],
      '/nodes/r/effects/0/color',
    ],
    ['a missing inner-shadow colour', [{ ...INNER, color: undefined }], '/nodes/r/effects/0/color'],
    [
      'an inner-shadow radius above 1000',
      [{ ...INNER, radius: 1000.5 }],
      '/nodes/r/effects/0/radius',
    ],
    [
      'an inner-shadow offset past 10000',
      [{ ...INNER, offsetX: 10_001 }],
      '/nodes/r/effects/0/offsetX',
    ],
    [
      'a negative background-blur radius',
      [{ ...BACKDROP, radius: -1 }],
      '/nodes/r/effects/0/radius',
    ],
    ['nine effects', Array.from({ length: 9 }, () => INNER), '/nodes/r/effects'],
  ])('refuses %s', (_name, effects, path) => {
    const value = documentOf(effects);
    expect(pick(parseDocument(JSON.stringify(value)))).toEqual(refusal(path));
    expect(pick(validateDocument(value))).toEqual(refusal(path));
  });

  it('allows one layer blur and one background blur together', () => {
    expect(validateDocument(documentOf([BLUR, BACKDROP])).ok).toBe(true);
  });

  it.each([
    ['an inner shadow', INNER],
    ['a background blur', BACKDROP],
  ])('refuses %s in a v7 document at its kind; migration keeps v7 effects', (_name, effect) => {
    const value = documentOf([SHADOW, effect], 7);
    expect(pick(parseDocument(JSON.stringify(value)))).toEqual(refusal('/nodes/r/effects/1/kind'));
    expect(pick(validateAnyDocument(value))).toEqual(refusal('/nodes/r/effects/1/kind'));
    const v7 = documentOf([SHADOW, BLUR], 7) as unknown as DocumentV7;
    const migrated = migrateV7toV8(v7);
    expect(migrated.ok && migrated.document.nodes.r!.effects).toEqual([SHADOW, BLUR]);
  });

  it('validateNode takes the v8 kinds', () => {
    expect(validateNode(rect([INNER, BACKDROP])).ok).toBe(true);
  });
});

function editor(projectEffects?: boolean | 'v1'): Editor {
  const ids = createCounterIdSource('n');
  return createEditor(projectEffects === undefined ? { ids } : { ids, projectEffects });
}

function run(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rectangle(target: Editor, x = 0): string {
  return run(target, { type: 'createRectangle', frame: { x, y: 0, width: 20, height: 20 } })[0]!;
}

const effectsOf = (target: Editor, id: string) => target.getSnapshot().document.nodes[id]!.effects;
const nodesOf = (target: Editor, ids: readonly string[]): NodeV8[] =>
  ids.map((id) => target.getSnapshot().document.nodes[id]!);

describe('V36-A02 the projector (V36-S5)', () => {
  const effects: Effect[] = [SHADOW, INNER, BLUR, BACKDROP];

  it("leaves the new kinds out under true and emits them under 'v1', with σ = radius / 2", () => {
    expect(sceneEffects(effects, true).map((effect) => effect.kind)).toEqual([
      'dropShadow',
      'layerBlur',
    ]);
    expect(sceneEffects(effects, 'v1')).toEqual([
      { kind: 'dropShadow', color: SHADOW.color, offsetX: 0, offsetY: 4, sigma: 4 },
      { kind: 'innerShadow', color: INNER.color, offsetX: 0, offsetY: 4, sigma: 2 },
      { kind: 'layerBlur', sigma: 2 },
      { kind: 'backgroundBlur', sigma: 2 },
    ]);
    expect(sceneEffects([{ ...INNER, visible: false }], 'v1')).toEqual([]);
  });

  it("a renderer on 'v1' applies the projected scene; one on 'v0' gets no new kind under true", () => {
    for (const [projection, level] of [
      ['v1', 'v1'],
      [true, 'v0'],
    ] as const) {
      const target = editor(projection);
      const id = rectangle(target);
      run(target, { type: 'addEffect', ids: [id], kind: 'innerShadow' });
      const renderer = new RecordingRenderer('supported', {
        groupOpacity: 'supported',
        effects: level,
      });
      target.attachRenderer(renderer);
      expect(renderer.calls[0]!.result.status).toBe('applied');
      const node = renderer.mirror.readRetainedScene()!.getNode(id)!;
      if (projection === 'v1') expect(node.effects?.[0]?.kind).toBe('innerShadow');
      else expect('effects' in node).toBe(false);
    }
  });

  it('the effectKinds query lists the kinds the projection draws', () => {
    expect(editor().query({ type: 'effectKinds' })).toEqual(['dropShadow', 'layerBlur']);
    expect(editor(true).query({ type: 'effectKinds' })).toEqual(['dropShadow', 'layerBlur']);
    expect(editor('v1').query({ type: 'effectKinds' })).toEqual([
      'dropShadow',
      'innerShadow',
      'layerBlur',
      'backgroundBlur',
    ]);
  });
});

describe('V36-A08 the commands (section 6)', () => {
  it('adds the Figma defaults', () => {
    const target = editor('v1');
    const id = rectangle(target);
    run(target, { type: 'addEffect', ids: [id], kind: 'innerShadow' });
    run(target, { type: 'addEffect', ids: [id], kind: 'backgroundBlur' });
    expect(effectsOf(target, id)).toEqual([INNER, BACKDROP]);
  });

  it('refuses a second background blur with the notice, and no change', () => {
    const target = editor('v1');
    const a = rectangle(target);
    const b = rectangle(target, 40);
    run(target, { type: 'addEffect', ids: [a], kind: 'backgroundBlur' });
    const before = target.getSnapshot().document;
    const result = target.execute(addEffectCommand(nodesOf(target, [b, a]), 'backgroundBlur'));
    expect(result).toMatchObject({
      ok: false,
      code: 'editor.effect-limit',
      path: `/nodes/${a}/effects`,
    });
    expect(target.getSnapshot().document).toBe(before);
    expect(effectNotice(result)).toBe(
      'A layer takes at most 8 effects, at most one layer blur and one background blur',
    );
  });

  it('changes a kind within its family, keeping its fields; one undo step', () => {
    const target = editor('v1');
    const id = rectangle(target);
    run(target, { type: 'addEffect', ids: [id], kind: 'dropShadow' });
    run(target, { type: 'addEffect', ids: [id], kind: 'layerBlur' });
    run(target, { type: 'setEffect', ids: [id], index: 0, patch: { kind: 'innerShadow' } });
    run(target, {
      type: 'setEffect',
      ids: [id],
      index: 1,
      patch: { kind: 'backgroundBlur', radius: 10 },
    });
    expect(effectsOf(target, id)).toEqual([
      { ...SHADOW, kind: 'innerShadow' },
      { ...BLUR, kind: 'backgroundBlur', radius: 10 },
    ]);
    run(target, { type: 'undo' });
    expect(effectsOf(target, id)).toEqual([{ ...SHADOW, kind: 'innerShadow' }, BLUR]);
  });

  it('refuses a change across families, an unknown kind and a second blur of one kind', () => {
    const target = editor('v1');
    const id = rectangle(target);
    run(target, { type: 'addEffect', ids: [id], kind: 'dropShadow' });
    run(target, { type: 'addEffect', ids: [id], kind: 'layerBlur' });
    run(target, { type: 'addEffect', ids: [id], kind: 'backgroundBlur' });
    const before = target.getSnapshot().document;
    const set = (index: number, kind: unknown) =>
      target.execute({ type: 'setEffect', ids: [id], index, patch: { kind } } as Command);
    expect(set(0, 'layerBlur')).toMatchObject({
      ok: false,
      code: 'editor.invalid-command',
      path: '/patch/kind',
    });
    expect(set(0, 'glow')).toMatchObject({
      ok: false,
      code: 'editor.invalid-command',
      path: '/patch/kind',
    });
    expect(set(1, 'backgroundBlur')).toMatchObject({
      ok: false,
      code: 'editor.effect-limit',
      path: `/nodes/${id}/effects`,
    });
    expect(target.getSnapshot().document).toBe(before);
  });

  it('with several nodes a kind change skips the other family; a refusal on one node refuses all', () => {
    const target = editor('v1');
    const a = rectangle(target);
    const b = rectangle(target, 40);
    const c = rectangle(target, 80);
    run(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    run(target, { type: 'addEffect', ids: [b], kind: 'layerBlur' });
    run(target, { type: 'setEffect', ids: [a, b], index: 0, patch: { kind: 'innerShadow' } });
    expect(effectsOf(target, a)).toEqual([{ ...SHADOW, kind: 'innerShadow' }]);
    expect(effectsOf(target, b)).toEqual([BLUR]);

    run(target, { type: 'addEffect', ids: [c], kind: 'layerBlur' });
    run(target, { type: 'addEffect', ids: [c], kind: 'backgroundBlur' });
    const before = target.getSnapshot().document;
    // b's blur could become a background blur, c's would be its second: nothing changes.
    expect(
      target.execute({
        type: 'setEffect',
        ids: [b, c],
        index: 0,
        patch: { kind: 'backgroundBlur' },
      }),
    ).toMatchObject({ ok: false, code: 'editor.effect-limit', path: `/nodes/${c}/effects` });
    expect(target.getSnapshot().document).toBe(before);
  });

  it('inner shadows and background blur add no visual-bounds margin', () => {
    const target = editor('v1');
    const id = rectangle(target);
    const bounds = () => {
      const document = target.getSnapshot().document;
      return visualBounds(document, document.nodes[id]!);
    };
    const bare = bounds();
    run(target, { type: 'addEffect', ids: [id], kind: 'innerShadow' });
    run(target, { type: 'setEffect', ids: [id], index: 0, patch: { radius: 50, offsetX: 30 } });
    run(target, { type: 'addEffect', ids: [id], kind: 'backgroundBlur' });
    expect(bounds()).toEqual(bare);
  });

  it('a v7 clipboard fragment with a new kind is refused at its kind', () => {
    const target = editor('v1');
    const id = rectangle(target);
    run(target, { type: 'addEffect', ids: [id], kind: 'innerShadow' });
    run(target, { type: 'copy', ids: [id] });
    const text = target.query({ type: 'clipboard' })!;
    expect(target.execute({ type: 'paste', text }).ok).toBe(true);
    const v7 = text.replace('"schemaVersion":8,', '"schemaVersion":7,');
    expect(target.execute({ type: 'paste', text: v7 })).toMatchObject({
      ok: false,
      code: 'document.invalid-field',
    });
    expect((target.execute({ type: 'paste', text: v7 }) as { path: string }).path).toMatch(
      /\/effects\/0\/kind$/u,
    );
  });
});

describe('V-36 panel model (section 6)', () => {
  it('rows know their family; the kind select lists the offered kinds of it', () => {
    const target = editor('v1');
    const a = rectangle(target);
    const b = rectangle(target, 40);
    run(target, { type: 'addEffect', ids: [a, b], kind: 'innerShadow' });
    run(target, { type: 'addEffect', ids: [a], kind: 'layerBlur' });
    run(target, { type: 'addEffect', ids: [b], kind: 'dropShadow' });
    const rows = effectRows(nodesOf(target, [a, b]));
    expect(rows.map((row) => [row.kind, row.family, row.shadow])).toEqual([
      ['innerShadow', 'shadow', true],
      ['mixed', 'mixed', true],
    ]);
    const offered = ['dropShadow', 'innerShadow', 'layerBlur'] as const;
    expect(kindOptions(rows[0]!, offered)).toEqual(['dropShadow', 'innerShadow']);
    expect(kindOptions(rows[1]!, offered)).toEqual([]);
    expect(effectKindCommand(nodesOf(target, [a, b]), rows[0]!, 'dropShadow')).toEqual({
      type: 'setEffect',
      ids: [a, b],
      index: 0,
      patch: { kind: 'dropShadow' },
    });
  });

  it('keeps a kind the host no longer offers in its own select', () => {
    const target = editor('v1');
    const id = rectangle(target);
    run(target, { type: 'addEffect', ids: [id], kind: 'backgroundBlur' });
    const [row] = effectRows(nodesOf(target, [id]));
    expect(kindOptions(row!, ['dropShadow', 'innerShadow', 'layerBlur'])).toEqual([
      'layerBlur',
      'backgroundBlur',
    ]);
  });
});
