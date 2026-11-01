import path from 'node:path';
import ts from 'typescript';

// MVP M8 contract, M8-T1 and M8-T3: the *reach* of a package entry, computed with the TypeScript
// compiler API from built declarations. From the exports of the entry's `dist/index.d.ts`, each
// type reference (aliases, interfaces and their members, unions, generic arguments, `typeof`
// queries, heritage clauses, `import()` types) is followed into the declaration files of
// workspace packages; declarations under `node_modules` (other than workspace links, which
// resolve to `packages/*`) and the TypeScript libraries are not followed.

const root = path.resolve(import.meta.dirname, '../..');

/**
 * A path with forward slashes only. TypeScript reports file names with `/` on every platform
 * (`D:/a/...` on Windows) while `node:path` joins with the platform separator, so tests
 * normalize both sides with this before comparing or building expected messages.
 */
export function posixPath(file: string): string {
  return file.replaceAll('\\', '/');
}

/** One named declaration in the reach. */
export type ReachedName = Readonly<{
  name: string;
  /** The workspace directory that declares it, for example `packages/model`. */
  owner: string;
  /** Whether it is one of the roots (an export of the entry the reach started from). */
  root: boolean;
  /** Whether a type reference (an alias, interface, heritage or `import()` type) reached it. */
  viaType: boolean;
  /** Whether a `typeof` query reached it. */
  viaTypeof: boolean;
  /** Whether the symbol has a value meaning (a `const`, function, class or enum). */
  isValue: boolean;
  /** Whether it has a type meaning (an alias, interface, class or enum). */
  isType: boolean;
}>;

/** An export of an entry module, resolved through re-exports. */
export type EntryExport = Readonly<{
  name: string;
  /** The name of the resolved declaration (a re-export may rename). */
  declaredName: string;
  /** The workspace directory that declares the resolved symbol, or '' outside the workspace. */
  owner: string;
  /**
   * Whether the export is an alias whose chain is type only (`export type { X } from`, or a
   * `type X` specifier), so it carries no value. Declarations reached through `export type *`
   * are not aliases and report false.
   */
  typeOnly: boolean;
  isValue: boolean;
  isType: boolean;
}>;

export type Reach = Readonly<{
  /** The reach, sorted by owner, then name. */
  names: readonly ReachedName[];
  /** The exports of the entry, sorted by name. */
  exports: readonly EntryExport[];
  /** The program's syntactic and semantic diagnostics, formatted; empty when it resolves. */
  diagnostics: readonly string[];
  /** The exports of another workspace entry in the same program, resolved the same way. */
  entryExports(packageDir: string): readonly EntryExport[];
}>;

export type ReachOptions = Readonly<{
  /** Which entry exports start the walk; all of them by default. */
  roots?: (entry: EntryExport) => boolean;
}>;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The workspace directory (`packages/x` or `apps/x`) of a file, or null outside it. */
function ownerOf(fileName: string): string | null {
  const relative = path.relative(root, fileName).split(path.sep).join('/');
  if (relative.startsWith('..') || relative.split('/').includes('node_modules')) return null;
  const match = /^(packages|apps)\/[^/]+/u.exec(relative);
  return match === null ? null : match[0];
}

function resolve(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function declarationOwner(symbol: ts.Symbol): string | null {
  for (const declaration of symbol.declarations ?? []) {
    const owner = ownerOf(declaration.getSourceFile().fileName);
    if (owner !== null) return owner;
  }
  return null;
}

/**
 * Whether `symbol` is an alias and some link of its alias chain (`export type { X }`, a `type X`
 * specifier, `import type`) is type only, so the name carries no value.
 */
function typeOnlyChain(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  let link: ts.Symbol | undefined = symbol;
  while (link !== undefined && link.flags & ts.SymbolFlags.Alias) {
    if ((link.declarations ?? []).some((node) => ts.isTypeOnlyImportOrExportDeclaration(node))) {
      return true;
    }
    link = checker.getImmediateAliasedSymbol(link);
  }
  return false;
}

function meanings(symbol: ts.Symbol): { isValue: boolean; isType: boolean } {
  return {
    isValue: (symbol.flags & ts.SymbolFlags.Value) !== 0,
    isType: (symbol.flags & ts.SymbolFlags.Type) !== 0,
  };
}

/** Builds the reach of the built entry `<packageDir>/dist/index.d.ts` (build it first). */
export function computeReach(packageDir: string, options: ReachOptions = {}): Reach {
  const entryFile = path.join(root, packageDir, 'dist/index.d.ts');
  const program = ts.createProgram([entryFile], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();

  const moduleOf = (dir: string): ts.Symbol => {
    const file = program.getSourceFile(path.join(root, dir, 'dist/index.d.ts'));
    const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
    if (module === undefined) throw new Error(`m8-type-reach: ${dir} is not in the program`);
    return module;
  };

  const describe = (symbol: ts.Symbol): EntryExport => {
    const target = resolve(checker, symbol);
    return {
      name: symbol.name,
      declaredName: target.name,
      owner: declarationOwner(target) ?? '',
      typeOnly: typeOnlyChain(checker, symbol),
      ...meanings(target),
    };
  };

  const exportsOf = (dir: string): EntryExport[] =>
    checker
      .getExportsOfModule(moduleOf(dir))
      .map(describe)
      .sort((a, b) => byCodeUnit(a.name, b.name));

  const found = new Map<ts.Symbol, { root: boolean; viaType: boolean; viaTypeof: boolean }>();
  const queue: ts.Symbol[] = [];

  const reach = (symbol: ts.Symbol | undefined, how: 'root' | 'type' | 'typeof') => {
    if (symbol === undefined) return;
    const target = resolve(checker, symbol);
    if (declarationOwner(target) === null) return;
    // Type parameters and parameters are not named exports; whatever they reference is walked
    // with the declaration that holds them.
    if (target.flags & (ts.SymbolFlags.TypeParameter | ts.SymbolFlags.FunctionScopedVariable)) {
      return;
    }
    let entry = found.get(target);
    if (entry === undefined) {
      entry = { root: false, viaType: false, viaTypeof: false };
      found.set(target, entry);
      queue.push(target);
    }
    if (how === 'root') entry.root = true;
    else if (how === 'type') entry.viaType = true;
    else entry.viaTypeof = true;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      reach(checker.getSymbolAtLocation(node.typeName), 'type');
    } else if (ts.isExpressionWithTypeArguments(node)) {
      reach(checker.getSymbolAtLocation(node.expression), 'type');
    } else if (ts.isTypeQueryNode(node)) {
      reach(checker.getSymbolAtLocation(node.exprName), 'typeof');
    } else if (ts.isImportTypeNode(node) && node.qualifier !== undefined) {
      reach(checker.getSymbolAtLocation(node.qualifier), node.isTypeOf ? 'typeof' : 'type');
    }
    ts.forEachChild(node, visit);
  };

  const keep = options.roots ?? (() => true);
  for (const symbol of checker.getExportsOfModule(moduleOf(packageDir))) {
    if (keep(describe(symbol))) reach(symbol, 'root');
  }
  while (queue.length > 0) {
    const symbol = queue.shift()!;
    for (const declaration of symbol.declarations ?? []) {
      if (ownerOf(declaration.getSourceFile().fileName) !== null) visit(declaration);
    }
  }

  const names = [...found]
    .map(([symbol, how]) => ({
      name: symbol.name,
      owner: declarationOwner(symbol)!,
      ...how,
      ...meanings(symbol),
    }))
    .sort((a, b) => byCodeUnit(a.owner, b.owner) || byCodeUnit(a.name, b.name));
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  const cache = new Map<string, EntryExport[]>();
  return {
    names,
    exports: exportsOf(packageDir),
    diagnostics,
    entryExports(dir: string) {
      if (!cache.has(dir)) cache.set(dir, exportsOf(dir));
      return cache.get(dir)!;
    },
  };
}

/**
 * Compiles a consumer module `source`, placed at the repository root as if it were a file there,
 * against the built workspace declarations; returns its diagnostics, formatted with their codes.
 */
export function compileConsumer(source: string): readonly string[] {
  const fileName = path.join(root, '__m8-type-reach-consumer.ts');
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    path.resolve(name) === fileName
      ? ts.createSourceFile(name, source, language)
      : getSourceFile(name, language, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => path.resolve(name) === fileName || fileExists(name);
  const program = ts.createProgram([fileName], options, host);
  const file = program.getSourceFile(fileName)!;
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
    (diagnostic) =>
      `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  );
}
