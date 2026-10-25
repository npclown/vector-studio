import path from 'node:path';
import ts from 'typescript';

export const boundaries = new Map([
  ['@vector-studio/contracts', new Set()],
  // P5-U1: the document model imports nothing (P5 plan, section 2).
  ['@vector-studio/model', new Set()],
  // P5-U2: the editor core reaches the renderer only through contracts (P5 plan, section 2).
  ['@vector-studio/editor-core', new Set(['@vector-studio/contracts', '@vector-studio/model'])],
  ['@vector-studio/geometry-reference', new Set(['@vector-studio/contracts'])],
  ['@vector-studio/geometry-wasm', new Set(['@vector-studio/contracts'])],
  ['@vector-studio/renderer-core', new Set(['@vector-studio/contracts'])],
  [
    '@vector-studio/renderer-webgpu',
    new Set(['@vector-studio/contracts', '@vector-studio/renderer-core']),
  ],
  [
    // P-B1 (P3 V2): the host composition root may depend on geometry-wasm.
    // The playground manifest edge itself lands in V4 with its first import.
    '@vector-studio/playground',
    new Set([
      '@vector-studio/contracts',
      '@vector-studio/geometry-wasm',
      '@vector-studio/renderer-core',
      '@vector-studio/renderer-webgpu',
    ]),
  ],
]);

export const packageDirectories = [
  'packages/contracts',
  'packages/editor-core',
  'packages/geometry-reference',
  'packages/geometry-wasm',
  'packages/model',
  'packages/renderer-core',
  'packages/renderer-webgpu',
  'apps/playground',
];

export const sourceImportPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

// Resolve relative imports too: aliases must not be the only enforced boundary.
export function workspaceImportTarget(specifier, sourcePath, packageRoots) {
  if (specifier.startsWith('@vector-studio/')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return null;
  const target = path.resolve(path.dirname(sourcePath), specifier);
  for (const [name, root] of packageRoots) {
    const relative = path.relative(root, target);
    if (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    ) {
      return name;
    }
  }
  return null;
}

const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies'];

/** Internal workspace dependencies named by a manifest, sorted. */
export function manifestInternalDependencies(manifest) {
  const internal = new Set();
  for (const field of dependencyFields) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (dependency.startsWith('@vector-studio/')) internal.add(dependency);
    }
  }
  return [...internal].sort();
}

/**
 * Evaluates one package against the policy. `sources` are `{ path, text }`
 * with absolute paths; failures use `displayPath` for each source when given.
 */
export function evaluatePackageBoundaries({ manifest, sources, packageRoots, displayPath }) {
  const failures = [];
  const allowed = boundaries.get(manifest.name);
  if (!allowed) {
    return [`package name ${manifest.name} has no boundary policy`];
  }
  for (const dependency of manifestInternalDependencies(manifest)) {
    if (!allowed.has(dependency)) {
      failures.push(`${manifest.name}: manifest dependency on ${dependency} is forbidden`);
    }
  }
  for (const source of sources) {
    for (const match of source.text.matchAll(sourceImportPattern)) {
      const dependency = workspaceImportTarget(match[1], source.path, packageRoots);
      if (dependency && dependency !== manifest.name && !allowed.has(dependency)) {
        const shown = displayPath ? displayPath(source.path) : source.path;
        failures.push(`${shown}: source import of ${dependency} is forbidden`);
      }
    }
  }
  return failures;
}

// P-B2: WASM handle names that packages/contracts/src may not contain. The
// list omits `memory`, `epoch` and `offset`, which contracts use for other
// meanings (OUT_OF_MEMORY, scene epochs).
export const wasmHandlePatterns = [
  /wasm/iu,
  /pointer/iu,
  /linearmemory/iu,
  /memoryepoch/iu,
  /arena/iu,
  /\bptr\b/iu,
  /[A-Za-z0-9_$]Ptr\b/u,
];
export const contractsForbiddenPatterns = [
  { name: 'WebAssembly identifier', pattern: /\bWebAssembly\b/u },
  { name: 'GPU type', pattern: /\bGPU[A-Z]\w*/u },
  ...wasmHandlePatterns.map((pattern) => ({ name: 'WASM handle name', pattern })),
];

/**
 * Removes comments with the TypeScript scanner, so comment markers inside
 * string or template literals are not taken as comments.
 */
export function stripComments(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const braces = [];
  let output = '';
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.OpenBraceToken) braces.push('brace');
    if (kind === ts.SyntaxKind.TemplateHead) braces.push('template');
    if (kind === ts.SyntaxKind.CloseBraceToken && braces.pop() === 'template') {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateMiddle) braces.push('template');
    }
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      output += scanner.getTokenText().replace(/[^\n]/gu, ' ');
    } else {
      output += scanner.getTokenText();
    }
  }
  return output;
}

/**
 * P-B2: contracts sources name no WebAssembly, GPU or WASM handle type, and
 * every import is a relative specifier that resolves inside the contracts
 * source root.
 */
export function evaluateContractsPurity({ sources, contractsSourceRoot, displayPath }) {
  const failures = [];
  for (const source of sources) {
    const shown = displayPath ? displayPath(source.path) : source.path;
    const code = stripComments(source.text);
    for (const { name, pattern } of contractsForbiddenPatterns) {
      const match = code.match(pattern);
      if (match) failures.push(`${shown}: contracts name ${name} "${match[0]}"`);
    }
    for (const match of code.matchAll(sourceImportPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) {
        failures.push(`${shown}: contracts import of bare specifier ${specifier} is forbidden`);
        continue;
      }
      const target = path.resolve(path.dirname(source.path), specifier);
      const relative = path.relative(contractsSourceRoot, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        failures.push(`${shown}: contracts import ${specifier} leaves packages/contracts/src`);
      }
    }
  }
  return failures;
}
