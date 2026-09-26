import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const usage =
  'Expected --profile functional|reference, optional --output-dir <fresh directory>, and --environment-json <file> for reference.';

export function validateP1Environment(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Reference environment metadata must be an object.');
  const metadata = value;
  if (
    typeof metadata.observedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(metadata.observedAt) ||
    !Number.isFinite(Date.parse(metadata.observedAt))
  )
    throw new Error('Reference environment observedAt must be an ISO timestamp.');
  const observation = (key) => {
    const item = metadata[key];
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new Error(`Reference environment ${key} must include value and source.`);
    if (typeof item.value !== 'string' || item.value.trim() === '')
      throw new Error(`Reference environment ${key}.value must be non-empty.`);
    if (typeof item.source !== 'string' || item.source.trim() === '')
      throw new Error(`Reference environment ${key}.source must be non-empty.`);
    return { value: item.value, source: item.source };
  };
  const displayRefresh = metadata.displayRefreshHz;
  if (
    displayRefresh === null ||
    typeof displayRefresh !== 'object' ||
    Array.isArray(displayRefresh) ||
    !Number.isFinite(displayRefresh.value) ||
    displayRefresh.value <= 0 ||
    typeof displayRefresh.source !== 'string' ||
    displayRefresh.source.trim() === ''
  )
    throw new Error('Reference environment displayRefreshHz.value must be a positive number.');
  return {
    observedAt: metadata.observedAt,
    displayRefreshHz: { value: displayRefresh.value, source: displayRefresh.source },
    power: observation('power'),
    backgroundLoad: observation('backgroundLoad'),
    driver: observation('driver'),
    display: observation('display'),
  };
}

export function parseP1Arguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--profile', '--output-dir', '--environment-json'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(usage);
    options.set(key, value);
  }
  const profile = options.get('--profile');
  if (profile !== 'functional' && profile !== 'reference')
    throw new Error(
      'P1 runner supports only explicit --profile functional or --profile reference.',
    );
  const environmentPath = options.get('--environment-json');
  if (profile === 'reference' && !environmentPath)
    throw new Error(
      'Reference runs require --environment-json <file> before build or output reservation.',
    );
  if (profile === 'functional' && environmentPath)
    throw new Error('Functional runs do not accept reference environment metadata.');
  const environment =
    environmentPath === undefined
      ? undefined
      : validateP1Environment(JSON.parse(readFileSync(environmentPath, 'utf8')));
  return { profile, outputDirectory: options.get('--output-dir'), environment };
}

export function reserveP1Output(root, requested) {
  const parent = path.resolve(root, 'artifacts/p1.6b');
  const directory = path.resolve(root, requested ?? path.join(parent, randomUUID()));
  const relative = path.relative(parent, directory);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  )
    throw new Error('Use a fresh immediate child of artifacts/p1.6b outside test cleanup.');
  mkdirSync(parent, { recursive: true });
  mkdirSync(directory);
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
    `${JSON.stringify({ command, profile: options.profile, environment: options.environment ?? null, createdAt: new Date().toISOString() }, null, 2)}\n`,
    { flag: 'wx' },
  );
  const environment = {
    ...process.env,
    P1_RUNNER_OUTPUT_DIR: directory,
    P1_RUNNER_COMMAND: JSON.stringify(command),
    P1_RUNNER_BUILD_MODE: 'production',
    P1_RUNNER_PROFILE: options.profile,
    ...(options.environment === undefined
      ? {}
      : { P1_RUNNER_ENVIRONMENT: JSON.stringify(options.environment) }),
  };
  if (options.environment === undefined) delete environment.P1_RUNNER_ENVIRONMENT;
  for (const arguments_ of [
    ['build'],
    ['exec', 'playwright', 'test', '--config', 'playwright.p1-runner.config.ts'],
  ]) {
    const result = spawnSync(process.execPath, [packageManagerEntry, ...arguments_], {
      env: environment,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
  console.log(`P1 ${options.profile} records: ${directory}. P1/A09/A10 remain UNVERIFIED.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
