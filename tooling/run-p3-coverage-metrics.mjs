import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P3.1o O01 offline metrics: docs/plans/p3-o01-coverage-experiment-contract.md.
// Usage: pnpm coverage:p3-o01 <capture-directory> [--replay]
//   default   writes <capture-directory>/metrics.json (exclusive create; fails if it exists)
//   --replay  recomputes and requires byte equality with the existing metrics.json

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = path.join(root, 'vitest.p3-coverage.config.ts');
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');

export function parseArguments(args) {
  const replay = args.includes('--replay');
  const rest = args.filter((arg) => arg !== '--replay');
  if (rest.length !== 1 || !rest[0]) throw new Error('Expected <capture-directory> [--replay].');
  return { directory: path.resolve(rest[0]), replay };
}

export function main(args = process.argv.slice(2)) {
  const { directory, replay } = parseArguments(args);
  const hasCapture =
    existsSync(path.join(directory, 'capture-index.json')) ||
    existsSync(path.join(directory, 'capture.json'));
  if (!hasCapture) throw new Error(`No capture.json or capture-index.json in ${directory}.`);
  const metrics = path.join(directory, 'metrics.json');
  if (!replay && existsSync(metrics)) throw new Error(`${metrics} already exists.`);
  if (replay && !existsSync(metrics)) throw new Error(`${metrics} is missing.`);
  const env = { ...process.env };
  delete env.P3_COVERAGE_CAPTURE;
  delete env.P3_COVERAGE_REPLAY;
  env[replay ? 'P3_COVERAGE_REPLAY' : 'P3_COVERAGE_CAPTURE'] = directory;
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Coverage metrics failed (${result.status ?? result.signal}).`);
  console.log(`P3 coverage metrics ${replay ? 'REPLAY' : 'WRITE'}: PASS; ${metrics}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
