import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  boundaries,
  evaluateContractsPurity,
  evaluatePackageBoundaries,
  manifestInternalDependencies,
  packageDirectories,
} from './boundary-policy.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const graphLines = [];
const packageRoots = new Map();
for (const directory of packageDirectories) {
  const root = path.join(repositoryRoot, directory);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  packageRoots.set(manifest.name, root);
}
const displayPath = (sourcePath) => path.relative(repositoryRoot, sourcePath);

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

async function readSources(directory) {
  return Promise.all(
    (await collectTypeScriptFiles(directory)).map(async (sourcePath) => ({
      path: sourcePath,
      text: await readFile(sourcePath, 'utf8'),
    })),
  );
}

for (const relativeDirectory of packageDirectories) {
  const packageDirectory = path.join(repositoryRoot, relativeDirectory);
  const manifestPath = path.join(packageDirectory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (!boundaries.has(manifest.name)) {
    failures.push(`${relativeDirectory}: package name ${manifest.name} has no boundary policy`);
    continue;
  }

  const sources = await readSources(path.join(packageDirectory, 'src'));
  failures.push(...evaluatePackageBoundaries({ manifest, sources, packageRoots, displayPath }));

  const dependencyList = manifestInternalDependencies(manifest);
  graphLines.push(
    `${manifest.name} -> ${dependencyList.length > 0 ? dependencyList.join(', ') : '(none)'}`,
  );
}

// P-B2: the contracts package stays plain data with contracts-only imports.
const contractsSourceRoot = path.join(repositoryRoot, 'packages/contracts/src');
const contractsFailures = evaluateContractsPurity({
  sources: await readSources(contractsSourceRoot),
  contractsSourceRoot,
  displayPath,
});
failures.push(...contractsFailures);

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
  console.log('\nContracts purity: PASS');
  console.log('\nDependency boundaries: PASS');
}
