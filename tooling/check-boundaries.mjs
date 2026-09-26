import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { boundaries, packageDirectories, workspaceImportTarget } from './boundary-policy.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourceImportPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const failures = [];
const graphLines = [];
const packageRoots = new Map();
for (const directory of packageDirectories) {
  const root = path.join(repositoryRoot, directory);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  packageRoots.set(manifest.name, root);
}

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
      const dependency = workspaceImportTarget(match[1], sourcePath, packageRoots);
      if (dependency && dependency !== manifest.name && !allowedDependencies.has(dependency)) {
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
