import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serializeDocument, type JsonValue } from '@vector-studio/model';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  extensionCommand,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
  type Extension,
  type ExtensionCommandBuilder,
  type ExtensionSummary,
  type Platform,
  type StarCreateArgs,
} from '../../packages/editor-core/src/index.js';
import { compileConsumer, computeReach } from '../support/m8-type-reach.js';

// MVP M8 contract, unit M8-U1: the type re-exports of `editor-core` (M8-T1, M8-A01), the
// `extensions` query (M8-X1) and `extensionCommand` with `StarCreateArgs` (M8-X2, M8-A05). The
// reach is computed from the built declarations, so `pnpm typecheck` (or a build) runs first, as
// in `pnpm check`.

const root = path.resolve(import.meta.dirname, '../..');
const EDITOR_CORE = 'packages/editor-core';
const MODEL = 'packages/model';
const CONTRACTS = 'packages/contracts';
const frame = { x: 360, y: 220, width: 160, height: 160 };

async function runtimeKeys(dir: string): Promise<string[]> {
  const module = (await import(
    pathToFileURL(path.join(root, dir, 'dist/index.js')).href
  )) as object;
  return Object.keys(module).sort();
}

describe('M8-A01 editor-core re-exports its model and contracts reach', () => {
  // The roots are editor-core's own exports, so the re-exports themselves cannot widen the
  // reach: the re-exported set must equal what editor-core's own declarations reach.
  const reach = computeReach(EDITOR_CORE, { roots: (entry) => entry.owner === EDITOR_CORE });
  const reached = reach.names.filter((name) => name.owner === MODEL || name.owner === CONTRACTS);
  const reachedTypes = reached.filter((name) => name.viaType);
  const typeofOnly = reached.filter((name) => !name.viaType);
  const reExports = reach.exports.filter(
    (entry) => entry.owner === MODEL || entry.owner === CONTRACTS,
  );

  it('builds the program from the built declarations without diagnostics', () => {
    expect(reach.diagnostics).toEqual([]);
    expect(reachedTypes.length).toBeGreaterThan(0);
    // Legacy names reached through alias chains are part of the reach (M8-Q2 (a)).
    const names = reachedTypes.map((name) => name.name);
    for (const legacy of ['PageV1', 'PageV2', 'PageV3', 'PageV4', 'PageV5', 'InstanceNodeV5']) {
      expect(names).toContain(legacy);
    }
    expect(names).toContain('NodeBaseV2');
    expect(names).toContain('GroupNode');
    expect(names).toContain('TextLayoutPort');
  });

  it('re-exports every reached type, type only, with its name unchanged, and nothing more', () => {
    const key = (entry: { owner: string; name: string }) => `${entry.owner}:${entry.name}`;
    expect(reExports.map(key).sort()).toEqual(reachedTypes.map(key).sort());
    for (const entry of reExports) {
      expect(entry, entry.name).toMatchObject({
        declaredName: entry.name,
        typeOnly: true,
        isType: true,
        isValue: false,
      });
      // Each one is the same declaration its own package's entry exports under that name.
      const owner = reach.entryExports(entry.owner).find((other) => other.name === entry.name);
      expect(owner, entry.name).toMatchObject({ declaredName: entry.name, owner: entry.owner });
    }
  });

  it('does not re-export a value reached only through typeof, but its derived alias', () => {
    expect(typeofOnly.map((name) => `${name.owner}:${name.name}`)).toEqual([
      'packages/model:DOCUMENT_ERROR_CODES',
    ]);
    expect(typeofOnly.every((name) => name.isValue && !name.isType)).toBe(true);
    const exported = new Set(reach.exports.map((entry) => entry.name));
    for (const name of typeofOnly) expect(exported.has(name.name), name.name).toBe(false);
    expect(exported.has('DocumentErrorCode')).toBe(true);
  });

  it('lets a consumer of editor-core alone import every reached name', () => {
    const names = reachedTypes.map((name) => name.name);
    const source = [
      `import type { ${names.join(', ')} } from '@vector-studio/editor-core';`,
      `export type Reached = [${names.join(', ')}];`,
    ].join('\n');
    expect(compileConsumer(source)).toEqual([]);
    // A typeof-only value is not importable, not even as a type.
    const negative = [
      "import type { DOCUMENT_ERROR_CODES } from '@vector-studio/editor-core';",
      'export type Codes = typeof DOCUMENT_ERROR_CODES;',
    ].join('\n');
    const errors = compileConsumer(negative);
    expect(errors).toHaveLength(1);
    // TS2305, or TS2724 when the compiler suggests a similar name.
    expect(errors[0]).toMatch(
      /^TS(2305|2724): .*has no exported member (named )?'DOCUMENT_ERROR_CODES'/u,
    );
  });

  it('re-exports no model or contracts value at run time', async () => {
    const own = await runtimeKeys(EDITOR_CORE);
    expect(own).toEqual([
      'DEFAULT_FRAME_FILL',
      'DEFAULT_KEYMAP',
      'DEFAULT_PATH_STROKE',
      'DEFAULT_RECTANGLE_FILL',
      'DEFAULT_SHAPE_STROKE',
      'ZOOM_MAX',
      'ZOOM_MIN',
      'createCounterIdSource',
      'createEditor',
      'eventChord',
      'extensionCommand',
      'starExtension',
    ]);
    const others = new Set([...(await runtimeKeys(MODEL)), ...(await runtimeKeys(CONTRACTS))]);
    expect(own.filter((name) => others.has(name))).toEqual([]);
    expect(reach.exports.filter((entry) => entry.isValue).map((entry) => entry.owner)).toEqual(
      own.map(() => EDITOR_CORE),
    );
  });
});

/** A second extension with two of each contribution, registered in reverse order. */
const testExtension: Extension = {
  id: 'ext.test',
  nodeTypes: ['ext.test.b', 'ext.test.a'].map((customType) => ({
    customType,
    validate: () => true,
    defaults: () => ({}),
    toScene: () => ({
      verbs: ['move', 'line', 'close'],
      points: [0, 0, 1, 1],
      fillRule: 'nonzero',
    }),
  })),
  commands: ['ext.test.zeta', 'ext.test.alpha'].map((id) => ({
    id,
    run: () => ({ ok: true, ids: [] }),
  })),
  tools: ['ext.test.pen', 'ext.test.brush'].map((id) => ({ id, input: () => false, reset() {} })),
  bindings: [
    { chord: 'Mod+Shift+K', action: 'ext.test.alpha' },
    { chord: 'B', action: 'setTool', args: { tool: 'ext.test.brush' } },
    { chord: 'Alt+J', action: null },
  ],
};

function editor(extensions: readonly Extension[], platform: Platform = 'other'): Editor {
  return createEditor({ ids: createCounterIdSource('n'), extensions, platform });
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('M8-A05 the extensions query (M8-X1)', () => {
  it('lists starExtension and a test extension, sorted, in canonical form', () => {
    const target = editor([testExtension, starExtension]);
    const list = target.query({ type: 'extensions' });
    expectTypeOf(list).toEqualTypeOf<readonly ExtensionSummary[]>();
    expect(list).toStrictEqual([
      {
        id: 'ext.star',
        nodeTypes: ['ext.star'],
        commands: ['ext.star.create'],
        tools: [],
        bindings: [],
      },
      {
        id: 'ext.test',
        nodeTypes: ['ext.test.a', 'ext.test.b'],
        commands: ['ext.test.alpha', 'ext.test.zeta'],
        tools: ['ext.test.brush', 'ext.test.pen'],
        bindings: ['Alt+KeyJ', 'Ctrl+Shift+KeyK', 'KeyB'],
      },
    ]);
    expectDeepFrozen(list);
    // `Mod` resolves for the editor's platform, as in the `keymap` query.
    expect(editor([testExtension], 'mac').query({ type: 'extensions' })[0]!.bindings).toEqual([
      'Alt+KeyJ',
      'KeyB',
      'Meta+Shift+KeyK',
    ]);
  });

  it('is an empty frozen list without extensions', () => {
    const list = editor([]).query({ type: 'extensions' });
    expect(list).toStrictEqual([]);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it('raises no event and stays the same value for the editor lifetime', () => {
    const target = editor([starExtension, testExtension]);
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    const snapshot = target.getSnapshot();
    const first = target.query({ type: 'extensions' });
    expect(target.query({ type: 'extensions' })).toBe(first);
    expect(events).toEqual([]);
    expect(target.getSnapshot()).toBe(snapshot);
    const document = target.query({ type: 'document' });
    for (const command of [
      extensionCommand<StarCreateArgs>('ext.star.create').command({ frame }),
      { type: 'setTool', tool: 'ext.test.pen' },
      { type: 'undo' },
      { type: 'loadDocument', document: JSON.parse(serializeDocument(document)) as unknown },
    ] satisfies Command[]) {
      expect(target.execute(command).ok, command.type).toBe(true);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(target.query({ type: 'extensions' })).toBe(first);
  });
});

describe('M8-A05 extensionCommand and StarCreateArgs (M8-X2)', () => {
  const star = extensionCommand<StarCreateArgs>('ext.star.create');

  it('is a frozen builder whose command equals a hand-written runCommand', () => {
    expectTypeOf(star).toEqualTypeOf<ExtensionCommandBuilder<StarCreateArgs>>();
    expectTypeOf(star.command).parameter(0).toEqualTypeOf<StarCreateArgs>();
    expectTypeOf(star.command).returns.toEqualTypeOf<Command>();
    expect(star.id).toBe('ext.star.create');
    expect(Object.isFrozen(star)).toBe(true);
    expect(star.command({ frame })).toStrictEqual({
      type: 'runCommand',
      id: 'ext.star.create',
      args: { frame },
    });
    expect(star.command({ frame, points: 7, innerRatio: 0.25 })).toStrictEqual({
      type: 'runCommand',
      id: 'ext.star.create',
      args: { frame, points: 7, innerRatio: 0.25 },
    });
    // Without a type argument the arguments are any JSON value.
    expectTypeOf(extensionCommand('ext.other').command).parameter(0).toEqualTypeOf<JsonValue>();
  });

  it('rejects a wrong argument shape at compile time', () => {
    const invalid = [
      // @ts-expect-error `frame` is required.
      () => star.command({ points: 5 }),
      // @ts-expect-error `points` is a number.
      () => star.command({ frame, points: '5' }),
      // @ts-expect-error `frame` needs `width` and `height`.
      () => star.command({ frame: { x: 0, y: 0 } }),
      // @ts-expect-error No other key.
      () => star.command({ frame, sides: 5 }),
      // @ts-expect-error The arguments are an object.
      () => star.command(5),
    ];
    expect(invalid).toHaveLength(5);
  });

  it('runs exactly as the hand-written command, run-time validation unchanged', () => {
    const cases: StarCreateArgs[] = [
      { frame },
      { frame, points: 6, innerRatio: 0.4 },
      { frame, points: 2 },
    ];
    for (const args of cases) {
      const built = editor([starExtension]);
      const byHand = editor([starExtension]);
      const result = built.execute(star.command(args));
      expect(result).toEqual(byHand.execute({ type: 'runCommand', id: 'ext.star.create', args }));
      expect(serializeDocument(built.query({ type: 'document' }))).toBe(
        serializeDocument(byHand.query({ type: 'document' })),
      );
    }
    expect(editor([starExtension]).execute(star.command({ frame, points: 2 }))).toEqual({
      ok: false,
      code: 'document.invalid-custom-data',
      path: '/data',
    });
  });
});
