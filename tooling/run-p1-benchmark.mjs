import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseP1Arguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--profile', '--output-dir'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error('Expected --profile functional and optional --output-dir <fresh directory>.');
    }
    options.set(key, value);
  }
  if (options.get('--profile') !== 'functional') {
    throw new Error(
      'P1.6a supports only explicit --profile functional; reference/acceptance remains blocked.',
    );
  }
  return { profile: 'functional', outputDirectory: options.get('--output-dir') };
}

export function reserveP1Output(root, requested) {
  const parent = path.resolve(root, 'artifacts/p1.6a');
  const directory = path.resolve(root, requested ?? path.join(parent, randomUUID()));
  const relative = path.relative(parent, directory);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error('Use a fresh immediate child of artifacts/p1.6a outside test cleanup.');
  }
  mkdirSync(parent, { recursive: true });
  mkdirSync(directory); // Exclusive: an existing run is never replaced.
  return directory;
}

function main() {
  const options = parseP1Arguments(process.argv.slice(2));
  const packageManagerEntry = process.env.npm_execpath;
  if (!packageManagerEntry) throw new Error('Run through pnpm benchmark:p1.');
  const directory = reserveP1Output(process.cwd(), options.outputDirectory);
  const command = ['pnpm', 'benchmark:p1', ...process.argv.slice(2)];
  writeFileSync(
    path.join(directory, 'invocation.json'),
    JSON.stringify(
      { command, profile: options.profile, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  for (const arguments_ of [
    ['build'],
    ['exec', 'playwright', 'test', '--config', 'playwright.p1-runner.config.ts'],
  ]) {
    const result = spawnSync(process.execPath, [packageManagerEntry, ...arguments_], {
      env: {
        ...process.env,
        P1_RUNNER_OUTPUT_DIR: directory,
        P1_RUNNER_COMMAND: JSON.stringify(command),
        P1_RUNNER_BUILD_MODE: 'production',
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log(`P1.6a functional records: ${directory}. P1 acceptance remains UNVERIFIED.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
