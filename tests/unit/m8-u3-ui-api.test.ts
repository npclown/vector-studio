import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as reactBindings from '@vector-studio/react';
import * as ui from '@vector-studio/ui';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  compileConsumer,
  computeReach,
  posixPath,
  type ReachedName,
} from '../support/m8-type-reach.js';

// MVP M8 contract, unit M8-U3: the `ui` half of M8-T2 and M8-T3 (M8-A02), the client directive
// of its entry (M8-H5, M8-A06) and the TSDoc of its own exports (section 9). The reach is
// computed from the built declarations, so `pnpm typecheck` (or a build) runs first, as in
// `pnpm check`.

const root = path.resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
const UI = 'packages/ui';
const REACT = 'packages/react';

/** The runtime exports of `ui` beyond `react`'s: sections 6 and 7.1. */
const OWN_VALUES = [
  'EditorPanels',
  'PanelBoundary',
  'PanelProvider',
  'ToolbarPrimaryRow',
  'ToolbarSecondaryRow',
  'resolvePanels',
  'usePanelErrors',
];
/** The type exports of `ui` beyond `react`'s. */
const OWN_TYPES = [
  'PanelBoundaryProps',
  'PanelBoundaryState',
  'PanelContribution',
  'PanelError',
  'PanelErrorCode',
  'PanelProviderProps',
  'PanelResolution',
  'ResolvedPanel',
  'ToolbarRowProps',
  'UiExtension',
];

describe('M8-A02 ui re-exports react and adds sections 6 and 7 (M8-T2, T3)', () => {
  const reach = computeReach(UI);
  const reachedTypes = reach.names.filter((name) => name.viaType || (name.root && name.isType));
  const exported = new Map(reach.exports.map((entry) => [entry.name, entry]));

  it('builds the program from the built declarations without diagnostics', () => {
    expect(reach.diagnostics).toEqual([]);
    const owners = new Set(reachedTypes.map((name) => name.owner));
    expect([...owners].sort()).toEqual([
      'packages/contracts',
      'packages/editor-core',
      'packages/model',
      REACT,
      UI,
    ]);
  });

  it('re-exports every export of react with its declaration, and adds only its own', () => {
    const react = reach.entryExports(REACT);
    for (const entry of react) {
      expect(exported.get(entry.name), entry.name).toMatchObject({
        declaredName: entry.declaredName,
        owner: entry.owner,
        isType: entry.isType,
        isValue: entry.isValue,
      });
    }
    // M8-T2 as amended in M8-U3: the explicit lists name every react export, the type exports
    // type only, so a type cannot become a value name; a list that drifts fails here.
    for (const entry of react.filter((other) => !other.isValue)) {
      expect(exported.get(entry.name)!.typeOnly, entry.name).toBe(true);
    }
    const own = reach.exports.filter((entry) => !react.some((other) => other.name === entry.name));
    expect(own.every((entry) => entry.owner === UI)).toBe(true);
    expect(own.filter((entry) => entry.isValue).map((entry) => entry.name)).toEqual(OWN_VALUES);
    expect(
      own
        .filter((entry) => !entry.isValue)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(OWN_TYPES);
  });

  it('declares every reached name in the entry of its owner package (owner-export check)', () => {
    const internal = (name: ReachedName) => {
      const entry = reach.entryExports(name.owner).find((other) => other.name === name.name);
      return entry === undefined || entry.declaredName !== name.name || entry.owner !== name.owner;
    };
    expect(
      reachedTypes.filter(internal).map((name) => `${name.owner}: ${name.name} is not exported`),
    ).toEqual([]);
  });

  it('lets a consumer of ui alone name every reached type', () => {
    const names = reachedTypes.map((name) => name.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [...OWN_TYPES, 'ExtensionSummary', 'NodeV6', 'RenderCamera', 'Paint']) {
      expect(names, name).toContain(name);
    }
    for (const name of names) expect(exported.get(name), name).toBeDefined();
    const source = [
      `import type { ${names.join(', ')} } from '@vector-studio/ui';`,
      `export type { ${names.join(', ')} };`,
    ].join('\n');
    expect(compileConsumer(source)).toEqual([]);
  });

  it('re-exports no editor-core value other than extensionCommand, not even as a type', () => {
    for (const value of ['createEditor', 'starExtension', 'DEFAULT_KEYMAP']) {
      const errors = compileConsumer(
        [
          `import type { ${value} } from '@vector-studio/ui';`,
          `export type Value = typeof ${value};`,
        ].join('\n'),
      );
      expect(errors, value).toHaveLength(1);
      expect(errors[0], value).toMatch(
        new RegExp(`^TS(2305|2724): .*has no exported member (named )?'${value}'`, 'u'),
      );
    }
  });

  it("has react's runtime exports, the same values, plus sections 6 and 7", () => {
    const reactKeys = Object.keys(reactBindings).sort();
    expect(Object.keys(ui).sort()).toEqual([...reactKeys, ...OWN_VALUES].sort());
    for (const key of reactKeys) {
      expect(ui[key as keyof typeof ui], key).toBe(
        reactBindings[key as keyof typeof reactBindings],
      );
    }
  });
});

/** The `export *` and `export * as` declarations of a module, as their source text. */
function starExports(fileName: string, text: string): string[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  return file.statements
    .filter(
      (statement): statement is ts.ExportDeclaration =>
        ts.isExportDeclaration(statement) &&
        (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)),
    )
    .map((statement) => statement.getText(file));
}

describe('M8-A06 the ui entry is a client module (M8-H5)', () => {
  // Next.js's flight loader rejects a client boundary that uses `export *` when a Server
  // Component imports it: "It's currently unsupported to use "export *" in a client boundary.
  // Please use named exports instead." So the entry names its re-exports (M8-T2, amended).
  it('has no export * in the entry source or the built entry', async () => {
    for (const file of ['src/index.ts', 'dist/index.js', 'dist/index.d.ts']) {
      const text = await readFile(path.join(root, UI, file), 'utf8');
      expect(starExports(file, text), file).toEqual([]);
    }
    // The guard sees both forms, and not a comment.
    expect(
      starExports(
        'planted.ts',
        "// export * from 'a';\nexport * from 'b';\nexport * as c from 'c';\nexport { d } from 'd';\n",
      ),
    ).toEqual(["export * from 'b';", "export * as c from 'c';"]);
  });

  it('begins the source and the built dist/index.js with the use client directive', async () => {
    for (const file of ['src/index.ts', 'dist/index.js']) {
      const text = await readFile(path.join(root, UI, file), 'utf8');
      expect(text.split('\n')[0], file).toBe("'use client';");
    }
  });

  it('imports the built ui package in a clean Node process without browser globals', async () => {
    const entry = pathToFileURL(path.join(root, UI, 'dist/index.js')).href;
    const script = [
      `const ui = await import(${JSON.stringify(entry)});`,
      "const globals = ['window', 'document'].filter((name) => name in globalThis);",
      'console.log(JSON.stringify({ globals, panels: typeof ui.PanelProvider }));',
    ].join('\n');
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script]);
    expect(JSON.parse(stdout)).toEqual({ globals: [], panels: 'function' });
  });
});

describe('MVP M8 section 9: every own export of ui carries TSDoc', () => {
  it('finds a documentation comment on each own export of the built entry', () => {
    const entry = path.join(root, UI, 'dist/index.d.ts');
    const program = ts.createProgram([entry], {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
      types: [],
    });
    const checker = program.getTypeChecker();
    const module = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
    const undocumented: string[] = [];
    let own = 0;
    for (const symbol of checker.getExportsOfModule(module)) {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const file = target.declarations?.[0]?.getSourceFile().fileName ?? '';
      if (!posixPath(file).startsWith(`${posixPath(path.join(root, UI, 'dist'))}/`)) continue;
      own += 1;
      const text = ts.displayPartsToString(target.getDocumentationComment(checker)).trim();
      if (text === '') undocumented.push(symbol.name);
    }
    expect(own).toBe(OWN_VALUES.length + OWN_TYPES.length);
    expect(undocumented).toEqual([]);
  });
});
