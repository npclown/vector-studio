// Shared settings of the headed configs in the run tiers (docs/validation.md, "Headed run
// tiers"): `pnpm test:gpu` and the next-host suites. Plain JavaScript, so tools that import the
// configs with Node alone (tooling/m8-n3-configs.mjs) resolve it too.

/** `line` for the console, plus the per-spec timing record (tests/support/timing-reporter.ts). */
export const headedReporter = [['line'], ['./tests/support/timing-reporter.ts']];

/**
 * Worker count of a headed config: VS_HEADED_WORKERS (a positive integer), default 1.
 * Parallelism is by file and project: tests of one file in one project stay in order in one
 * worker, so every spec's evidence directory is laid out as in a one-worker run. Pass
 * `serial: true` for a suite that must not run beside anything else on the machine: one that
 * uses the system clipboard (shared by every browser window), or one that records a timing
 * observation a contract expects to be taken alone on the machine.
 */
export function headedWorkers(options = {}) {
  const value = process.env.VS_HEADED_WORKERS;
  if (value !== undefined && value !== '' && !/^[1-9]\d*$/u.test(value))
    throw new Error(`VS_HEADED_WORKERS must be a positive integer, got ${JSON.stringify(value)}`);
  if (options.serial === true || value === undefined || value === '') return 1;
  return Number(value);
}
