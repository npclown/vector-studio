import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P3.1o O02 offline metrics: docs/plans/p3-o02-a5-coverage-contract.md.
// Usage: pnpm coverage:p3-o02 <directory> [--replay]
//   Every directory at or below <directory> holding an O02 capture-index.json (one per browser) is
//   processed.
//   default   writes metrics.json, and metrics-dpr3.json when DPR 3 parts are present, next to each
//             capture-index.json (exclusive create; fails if one exists)
//   --replay  recomputes and requires byte equality with the existing metrics files

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = path.join(root, 'vitest.p3-o02.config.ts');
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const INDEX_SCHEMA = 'p3-o02-capture-index-v1';

export function parseArguments(args) {
  const replay = args.includes('--replay');
  const rest = args.filter((arg) => arg !== '--replay');
  if (rest.length !== 1 || !rest[0]) throw new Error('Expected <directory> [--replay].');
  return { directory: path.resolve(rest[0]), replay };
}

export function captureDirectories(directory) {
  const found = [];
  const visit = (current) => {
    const index = path.join(current, 'capture-index.json');
    if (existsSync(index) && JSON.parse(readFileSync(index, 'utf8')).schema === INDEX_SCHEMA)
      found.push(current);
    for (const name of readdirSync(current).sort()) {
      const child = path.join(current, name);
      if (statSync(child).isDirectory()) visit(child);
    }
  };
  visit(directory);
  return found;
}

export function main(args = process.argv.slice(2)) {
  const { directory, replay } = parseArguments(args);
  const directories = captureDirectories(directory);
  if (directories.length === 0)
    throw new Error(`No O02 capture-index.json at or below ${directory}.`);
  for (const current of directories) {
    const metrics = path.join(current, 'metrics.json');
    if (!replay && existsSync(metrics)) throw new Error(`${metrics} already exists.`);
    if (!replay && existsSync(path.join(current, 'metrics-dpr3.json')))
      throw new Error(`${path.join(current, 'metrics-dpr3.json')} already exists.`);
    if (replay && !existsSync(metrics)) throw new Error(`${metrics} is missing.`);
  }
  const env = { ...process.env };
  delete env.P3_O02_CAPTURE;
  delete env.P3_O02_REPLAY;
  env[replay ? 'P3_O02_REPLAY' : 'P3_O02_CAPTURE'] = directory;
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`O02 coverage metrics failed (${result.status ?? result.signal}).`);
  for (const current of directories)
    console.log(`P3 O02 coverage metrics ${replay ? 'REPLAY' : 'WRITE'}: PASS; ${current}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
