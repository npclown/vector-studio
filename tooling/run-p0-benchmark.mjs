import { spawnSync } from 'node:child_process';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const profile = option('--profile') ?? 'acceptance';
if (profile !== 'smoke' && profile !== 'acceptance') {
  console.error(`Unsupported P0 benchmark profile: ${profile}`);
  process.exit(2);
}

const outputDirectory = option('--output-dir') ?? 'docs/benchmarks/results';
const displayRefreshRate = option('--display-refresh-hz');
if (profile === 'acceptance' && displayRefreshRate === undefined) {
  console.error('Acceptance runs require --display-refresh-hz <number>.');
  process.exit(2);
}
if (
  displayRefreshRate !== undefined &&
  (!Number.isFinite(Number(displayRefreshRate)) || Number(displayRefreshRate) <= 0)
) {
  console.error('--display-refresh-hz must be a positive number.');
  process.exit(2);
}

const packageManagerEntry = process.env.npm_execpath;
if (!packageManagerEntry) {
  console.error('pnpm npm_execpath is unavailable; run this command through pnpm.');
  process.exit(2);
}
const environment = {
  ...process.env,
  P0_BENCHMARK_PROFILE: profile,
  P0_BENCHMARK_OUTPUT_DIR: outputDirectory,
  ...(displayRefreshRate === undefined ? {} : { P0_DISPLAY_REFRESH_HZ: displayRefreshRate }),
};
for (const arguments_ of [
  ['build'],
  ['exec', 'playwright', 'test', '--config', 'playwright.p0-benchmark.config.ts'],
]) {
  const result = spawnSync(process.execPath, [packageManagerEntry, ...arguments_], {
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
