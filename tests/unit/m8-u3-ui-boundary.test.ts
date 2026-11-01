import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { posixPath } from '../support/m8-type-reach.js';
import {
  boundaries,
  evaluatePackageBoundaries,
  evaluatePublicImports,
  externalDenied,
  importSpecifiers,
  isInsideDirectory,
  packageDirectories,
  publicImportPolicies,
  // @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
} from '../../tooling/boundary-policy.mjs';

// MVP M8 contract, unit M8-U3: the `@vector-studio/ui` manifest, tsconfig and boundary-policy
// entry (M8-B1, M8-B2, M8-A07) and the public-import check (M8-B3, M8-A08, an exit gate), with
// planted manifests and sources. The program checks read the built `packages/react/dist`, so
// `pnpm typecheck` (or a build) runs first, as in `pnpm check`.

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
type Source = { path: string; text: string };

const root = path.resolve(import.meta.dirname, '../..');
const policy = boundaries as Map<string, Set<string>>;
const denied = externalDenied as Map<string, Set<string>>;
const directories = packageDirectories as string[];
const evaluate = evaluatePackageBoundaries as (input: {
  manifest: Manifest;
  sources: Source[];
  packageRoots: Map<string, string>;
}) => string[];
const evaluatePublic = evaluatePublicImports as (input: {
  sources: Source[];
  sourceRoot: string;
  specifiers: readonly string[];
  displayPath?: (sourcePath: string) => string;
}) => string[];
const specifiersOf = importSpecifiers as (text: string) => string[];
const isInside = isInsideDirectory as (
  directory: string,
  sourcePath: string,
  specifier: string,
  api?: typeof path.win32,
) => boolean;
const publicPolicies = publicImportPolicies as { directory: string; specifiers: string[] }[];

const UI = '@vector-studio/ui';
const NEXT_HOST = '@vector-studio/next-host';
const uiRoot = path.join(root, 'packages/ui');
const uiSource = path.join(uiRoot, 'src');
const packageRoots = new Map([
  ['@vector-studio/contracts', path.join(root, 'packages/contracts')],
  ['@vector-studio/model', path.join(root, 'packages/model')],
  ['@vector-studio/editor-core', path.join(root, 'packages/editor-core')],
  ['@vector-studio/react', path.join(root, 'packages/react')],
  [UI, uiRoot],
  [NEXT_HOST, path.join(root, 'apps/next-host')],
]);
const planted = path.join(uiSource, 'planted.ts');
const display = (sourcePath: string) => path.relative(root, sourcePath).split(path.sep).join('/');
const PUBLIC = ['react', 'react/jsx-runtime', '@vector-studio/react'];

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, file), 'utf8')) as T;
}

async function uiSources(): Promise<Source[]> {
  const names = (await readdir(uiSource)).filter((name) => /\.tsx?$/u.test(name)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sourcePath = path.join(uiSource, name);
      return { path: sourcePath, text: await readFile(sourcePath, 'utf8') };
    }),
  );
}

describe('M8-A07 the ui manifest, tsconfig and boundary policy (M8-B1, M8-B2)', () => {
  it('allows react only, denies react-dom and next, and lists the package directory', () => {
    expect([...policy.get(UI)!]).toEqual(['@vector-studio/react']);
    expect([...denied.get(UI)!].sort()).toEqual(['next', 'react-dom']);
    expect(directories).toContain('packages/ui');
    // Among the other packages only next-host may depend on the UI package.
    expect([...policy].filter(([, allowed]) => allowed.has(UI)).map(([name]) => name)).toEqual([
      NEXT_HOST,
    ]);
  });

  it('depends on react only, with react and its types at the versions react uses', async () => {
    const manifest = await readJson<Manifest>('packages/ui/package.json');
    const react = await readJson<Manifest>('packages/react/package.json');
    expect(manifest.name).toBe(UI);
    expect(manifest.dependencies).toEqual({ '@vector-studio/react': 'workspace:*' });
    expect(manifest.peerDependencies).toEqual({ react: react.peerDependencies!['react'] });
    expect(manifest.devDependencies).toEqual({
      '@types/react': react.devDependencies!['@types/react'],
      react: react.devDependencies!['react'],
    });
    const config = await readJson<{ references: unknown }>('packages/ui/tsconfig.json');
    expect(config.references).toEqual([{ path: '../react' }]);
    const rootConfig = await readJson<{ references: { path: string }[] }>('tsconfig.json');
    expect(rootConfig.references).toContainEqual({ path: './packages/ui' });
  });

  it('passes the committed manifest and sources', async () => {
    const manifest = await readJson<Manifest>('packages/ui/package.json');
    const sources = await uiSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(evaluate({ manifest, sources, packageRoots })).toEqual([]);
  });

  it.each(['editor-core', 'model', 'contracts'])(
    'fails a planted %s import, by manifest, package name and relative path',
    (name) => {
      const target = `@vector-studio/${name}`;
      expect(
        evaluate({
          manifest: { name: UI, dependencies: { [target]: 'workspace:*' } },
          sources: [
            { path: planted, text: `import type { Value } from '${target}';\n` },
            { path: planted, text: `import type { Value } from '../../${name}/src/index.js';\n` },
          ],
          packageRoots: new Map([...packageRoots, [target, path.join(root, 'packages', name)]]),
        }),
      ).toEqual([
        `${UI}: manifest dependency on ${target} is forbidden`,
        `${planted}: source import of ${target} is forbidden`,
        `${planted}: source import of ${target} is forbidden`,
      ]);
    },
  );

  it.each(['react-dom', 'next'])('fails a planted %s import, by manifest and source', (name) => {
    expect(
      evaluate({
        manifest: { name: UI, dependencies: { [name]: '1.0.0' } },
        sources: [{ path: planted, text: `import value from '${name}/server';\n` }],
        packageRoots,
      }),
    ).toEqual([
      `${UI}: manifest dependency on ${name} is forbidden`,
      `${planted}: source import of ${name} is forbidden`,
    ]);
  });

  it('passes ui importing react and @vector-studio/react, and next-host importing ui', () => {
    expect(
      evaluate({
        manifest: {
          name: UI,
          dependencies: { '@vector-studio/react': 'workspace:*' },
          peerDependencies: { react: '^19.2.0' },
        },
        sources: [
          {
            path: planted,
            text: "import { useEditor } from '@vector-studio/react';\nimport { useState } from 'react';\n",
          },
        ],
        packageRoots,
      }),
    ).toEqual([]);
    expect(
      evaluate({
        manifest: { name: NEXT_HOST, dependencies: { [UI]: 'workspace:*' } },
        sources: [
          {
            path: path.join(root, 'apps/next-host/src/planted.tsx'),
            text: "import { PanelProvider } from '@vector-studio/ui';\n",
          },
        ],
        packageRoots,
      }),
    ).toEqual([]);
  });

  it('carries the ARCHITECTURE pointer for the ui package', async () => {
    const text = await readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8');
    expect(text).toContain('Pointer, 2026-11-01 (M8-U3');
    expect(text).toContain('`@vector-studio/ui`');
  });
});

/** Parsed declaration and source files shared by the programs below, which differ in one file. */
const parsed = new Map<string, ts.SourceFile>();
/** Each program type-checks the UI sources and the React and DOM declarations. */
const PROGRAM_TIMEOUT = 60_000;

/**
 * Compiles the UI sources with the UI tsconfig's options, plus `fixture` at
 * `packages/ui/src/planted.ts` when given. Returns the program and its diagnostics: every
 * pre-emit diagnostic without a fixture; with one, the program-level diagnostics and the
 * fixture's own.
 */
function compileUi(fixture?: string): { program: ts.Program; diagnostics: string[] } {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(uiRoot, 'tsconfig.json'),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  )!;
  const options: ts.CompilerOptions = {
    ...config.options,
    composite: false,
    declaration: false,
    declarationMap: false,
    incremental: false,
    noEmit: true,
  };
  delete options.tsBuildInfoFile;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) => {
    if (fixture !== undefined && path.resolve(name) === planted) {
      return ts.createSourceFile(name, fixture, language);
    }
    let file = parsed.get(name);
    if (file === undefined) {
      file = getSourceFile(name, language, ...rest);
      if (file !== undefined) parsed.set(name, file);
    }
    return file;
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) =>
    (fixture !== undefined && path.resolve(name) === planted) || fileExists(name);
  const files = fixture === undefined ? config.fileNames : [...config.fileNames, planted];
  const program = ts.createProgram(files, options, host);
  const found =
    fixture === undefined
      ? ts.getPreEmitDiagnostics(program)
      : [
          ...program.getOptionsDiagnostics(),
          ...program.getGlobalDiagnostics(),
          ...program.getSyntacticDiagnostics(program.getSourceFile(planted)),
          ...program.getSemanticDiagnostics(program.getSourceFile(planted)),
        ];
  const diagnostics = found.map((diagnostic) => {
    const file = diagnostic.file === undefined ? '' : `${display(diagnostic.file.fileName)}: `;
    return `${file}TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
  return { program, diagnostics };
}

describe('M8-A08 the UI sources import public exports only (M8-B3, exit gate)', () => {
  it('checks packages/ui/src with the policy check:boundaries runs', () => {
    // M8-U6 adds next-host's star panel as a second policy (M8-N2); tests/unit/m8-u6-next-host.test.ts.
    expect(publicPolicies[0]).toEqual({ directory: 'packages/ui/src', specifiers: PUBLIC });
    expect(publicPolicies.map((policy) => policy.directory)).toEqual([
      'packages/ui/src',
      'apps/next-host/src',
    ]);
  });

  it('passes the committed sources: public specifiers, or relative inside packages/ui/src', async () => {
    const sources = await uiSources();
    expect(
      evaluatePublic({ sources, sourceRoot: uiSource, specifiers: PUBLIC, displayPath: display }),
    ).toEqual([]);
    const bare = new Set(
      sources
        .flatMap((source) => specifiersOf(source.text))
        .filter((name) => !name.startsWith('.')),
    );
    expect([...bare].sort()).toEqual(['@vector-studio/react', 'react']);
  });

  it(
    'resolves @vector-studio/react only to packages/react/dist/index.d.ts',
    () => {
      const { program, diagnostics } = compileUi();
      expect(diagnostics).toEqual([]);
      const entry = path.join(root, 'packages/react/dist/index.d.ts');
      let seen = 0;
      for (const file of program.getSourceFiles()) {
        if (!posixPath(file.fileName).startsWith(`${posixPath(uiSource)}/`)) continue;
        for (const specifier of specifiersOf(file.text)) {
          if (specifier !== '@vector-studio/react') continue;
          const resolved = ts.resolveModuleName(
            specifier,
            file.fileName,
            program.getCompilerOptions(),
            ts.sys,
          ).resolvedModule;
          expect(resolved, file.fileName).toBeDefined();
          expect(posixPath(ts.sys.realpath!(resolved!.resolvedFileName)), file.fileName).toBe(
            posixPath(entry),
          );
          seen += 1;
        }
      }
      expect(seen).toBeGreaterThan(0);
      // Every other workspace file in the program is a built declaration, never a source.
      const workspace = program
        .getSourceFiles()
        .map((file) => display(ts.sys.realpath!(file.fileName)))
        .filter((name) => /^(packages|apps)\//u.test(name) && !name.startsWith('packages/ui/src/'));
      expect(workspace).toContain('packages/react/dist/index.d.ts');
      expect(
        workspace.filter((name) => !/^packages\/[^/]+\/dist\/[^/]+\.d\.ts$/u.test(name)),
      ).toEqual([]);
    },
    PROGRAM_TIMEOUT,
  );

  const fail = (specifier: string, reason: string) =>
    `packages/ui/src/planted.ts: import ${specifier} ${reason}`;
  const checkPlanted = (text: string) =>
    evaluatePublic({
      sources: [{ path: planted, text }],
      sourceRoot: uiSource,
      specifiers: PUBLIC,
      displayPath: display,
    });

  it(
    'fails a subpath of @vector-studio/react, by the check and by tsc',
    () => {
      const specifier = '@vector-studio/react/dist/context.js';
      const text = `import { useEditor } from '${specifier}';\nexport const hook = useEditor;\n`;
      expect(checkPlanted(text)).toEqual([fail(specifier, 'is not a public import')]);
      // The `exports` map of @vector-studio/react has the entry only.
      expect(compileUi(text).diagnostics).toEqual([
        `packages/ui/src/planted.ts: TS2307: Cannot find module '${specifier}' or its corresponding type declarations.`,
      ]);
    },
    PROGRAM_TIMEOUT,
  );

  it.each([
    ['@vector-studio/editor-core', 'createEditor'],
    ['@vector-studio/model', 'parseDocument'],
  ])('fails %s, by the check and by the boundary checker', (specifier, name) => {
    const text = `import { ${name} } from '${specifier}';\nexport const value = ${name};\n`;
    expect(checkPlanted(text)).toEqual([fail(specifier, 'is not a public import')]);
    expect(
      evaluate({ manifest: { name: UI }, sources: [{ path: planted, text }], packageRoots }),
    ).toEqual([`${planted}: source import of ${specifier} is forbidden`]);
  });

  it(
    'fails a relative path into packages/react/src, by the check and by tsc',
    () => {
      const specifier = '../../react/src/context.js';
      const text = `import { useEditor } from '${specifier}';\nexport const hook = useEditor;\n`;
      expect(checkPlanted(text)).toEqual([fail(specifier, 'leaves packages/ui/src')]);
      // The package boundary alone allows it (the target is @vector-studio/react): M8-B3 is the
      // check that rejects reaching past react's entry.
      expect(
        evaluate({ manifest: { name: UI }, sources: [{ path: planted, text }], packageRoots }),
      ).toEqual([]);
      expect(compileUi(text).diagnostics).toContainEqual(
        `packages/ui/src/planted.ts: TS6059: File '${posixPath(path.join(root, 'packages/react/src/context.tsx'))}' is not under 'rootDir' '${posixPath(uiSource)}'. 'rootDir' is expected to contain all source files.`,
      );
    },
    PROGRAM_TIMEOUT,
  );

  it('fails a type reference directive to another package, by the check', () => {
    const text = '/// <reference types="@vector-studio/editor-core" />\nexport {};\n';
    expect(checkPlanted(text)).toEqual([
      fail('@vector-studio/editor-core', 'is not a public import'),
    ]);
  });

  it('fails a backslash relative path out of packages/ui/src, as tsc reads it', () => {
    const specifier = '..\\..\\react\\src\\context.js';
    // JSON.stringify escapes the backslashes, so the planted string literal holds them.
    const text = `import { useEditor } from ${JSON.stringify(specifier)};\nexport const hook = useEditor;\n`;
    expect(checkPlanted(text)).toEqual([fail(specifier, 'leaves packages/ui/src')]);
  });

  it('keeps the inside test separator- and case-independent on Windows paths', () => {
    const src = 'D:\\a\\vs\\packages\\ui\\src';
    const file = 'D:/a/vs/packages/ui/src/panels.tsx';
    const win = path.win32;
    expect(isInside(src, file, './panel-resolve.js', win)).toBe(true);
    expect(isInside(src, 'd:\\A\\VS\\packages\\ui\\src\\x.ts', './y.js', win)).toBe(true);
    expect(isInside(src, file, '../../react/src/context.js', win)).toBe(false);
    expect(isInside(src, file, '..\\..\\react\\src\\context.js', win)).toBe(false);
    expect(isInside(src, file, '..', win)).toBe(false);
    expect(isInside(src, 'E:/other/x.ts', './y.js', win)).toBe(false);
    // POSIX, the platform default here.
    expect(isInside('/r/packages/ui/src', '/r/packages/ui/src/a.ts', './b.js', path.posix)).toBe(
      true,
    );
    expect(isInside('/r/packages/ui/src', '/r/packages/ui/src/a.ts', '../b.js', path.posix)).toBe(
      false,
    );
  });

  it('normalizes Windows separators in posixPath', () => {
    expect(posixPath('D:\\a\\vs\\packages\\ui\\dist')).toBe('D:/a/vs/packages/ui/dist');
    expect(posixPath('D:/a/vs/packages/react/dist/index.d.ts')).toBe(
      'D:/a/vs/packages/react/dist/index.d.ts',
    );
    expect(posixPath(path.win32.join('D:/a', 'packages/react/src/context.tsx'))).toBe(
      'D:/a/packages/react/src/context.tsx',
    );
  });

  it('fails a path reference directive into another package, by the check', () => {
    const specifier = '../../editor-core/dist/index.d.ts';
    const text = `/// <reference path="${specifier}" />\nexport {};\n`;
    expect(checkPlanted(text)).toEqual([fail(specifier, 'leaves packages/ui/src')]);
  });

  it('reads type imports, re-exports, dynamic imports and type references, and skips comments', () => {
    expect(
      specifiersOf(
        [
          '/// <reference types="node" />',
          '/// <reference path="./globals.d.ts" />',
          "// import { x } from '@vector-studio/model';",
          "/* export * from '@vector-studio/contracts'; */",
          "import type { A } from '@vector-studio/editor-core';",
          "export * from './local.js';",
          "export { b } from '../../react/src/hooks.js';",
          "const c = await import('react-dom');",
        ].join('\n'),
      ),
    ).toEqual([
      '@vector-studio/editor-core',
      './local.js',
      '../../react/src/hooks.js',
      'react-dom',
      'node',
      './globals.d.ts',
    ]);
  });
});
