import path from 'node:path';

export const boundaries = new Map([
  ['@vector-studio/contracts', new Set()],
  ['@vector-studio/geometry-reference', new Set(['@vector-studio/contracts'])],
  ['@vector-studio/renderer-core', new Set(['@vector-studio/contracts'])],
  [
    '@vector-studio/renderer-webgpu',
    new Set(['@vector-studio/contracts', '@vector-studio/renderer-core']),
  ],
  [
    '@vector-studio/playground',
    new Set([
      '@vector-studio/contracts',
      '@vector-studio/renderer-core',
      '@vector-studio/renderer-webgpu',
    ]),
  ],
]);

export const packageDirectories = [
  'packages/contracts',
  'packages/geometry-reference',
  'packages/renderer-core',
  'packages/renderer-webgpu',
  'apps/playground',
];

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
