import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const boundaries = new Map([
  ['@vector-studio/contracts', new Set()],
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

const packageDirectories = [
  'packages/contracts',
  'packages/renderer-core',
  'packages/renderer-webgpu',
  'apps/playground',
];

const sourceImportPattern = /(?:from\s+|import\s*\(|import\s+)["'](@vector-studio\/[^"']+)["']/g;
const failures = [];
const graphLines = [];

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

for (const relativeDirectory of packageDirectories) {
  const packageDirectory = path.join(repositoryRoot, relativeDirectory);
  const manifestPath = path.join(packageDirectory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const allowedDependencies = boundaries.get(manifest.name);

  if (!allowedDependencies) {
    failures.push(`${relativeDirectory}: package name ${manifest.name} has no boundary policy`);
    continue;
  }

  const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies'];
  const internalDependencies = new Set();

  for (const field of dependencyFields) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (dependency.startsWith('@vector-studio/')) {
        internalDependencies.add(dependency);
      }
    }
  }

  for (const dependency of internalDependencies) {
    if (!allowedDependencies.has(dependency)) {
      failures.push(`${manifest.name}: manifest dependency on ${dependency} is forbidden`);
    }
  }

  const sourceDirectory = path.join(packageDirectory, 'src');
  for (const sourcePath of await collectTypeScriptFiles(sourceDirectory)) {
    const source = await readFile(sourcePath, 'utf8');
    for (const match of source.matchAll(sourceImportPattern)) {
      const dependency = match[1];
      if (dependency && !allowedDependencies.has(dependency)) {
        failures.push(
          `${path.relative(repositoryRoot, sourcePath)}: source import of ${dependency} is forbidden`,
        );
      }
    }
  }

  const dependencyList = [...internalDependencies].sort();
  graphLines.push(
    `${manifest.name} -> ${dependencyList.length > 0 ? dependencyList.join(', ') : '(none)'}`,
  );
}

console.log('Workspace package graph:');
for (const line of graphLines) {
  console.log(`  ${line}`);
}

if (failures.length > 0) {
  console.error('\nDependency boundary violations:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nDependency boundaries: PASS');
}
