import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

// Per-spec timing for headed runs (docs/validation.md, "Headed run tiers"). Every headed config
// lists this reporter next to `line`, so each run leaves a small TSV of test durations under
// artifacts/headed-timing/ (or VS_HEADED_TIMING_DIR) and prints the slowest specs at the end.
// It records only names, projects, outcomes and milliseconds: no attachments, no output.

interface Row {
  file: string;
  project: string;
  title: string;
  status: string;
  milliseconds: number;
  workerIndex: number;
}

const field = (value: string) => value.replaceAll(/[\t\r\n]+/gu, ' ');

export default class TimingReporter implements Reporter {
  private readonly rows: Row[] = [];
  private config: FullConfig | undefined;
  private readonly started = Date.now();

  /** The directory of the config file: the repository root for every headed config. */
  private repository(): string {
    const file = this.config?.configFile;
    return file === undefined ? process.cwd() : path.dirname(file);
  }

  onBegin(config: FullConfig): void {
    this.config = config;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const root = this.repository();
    this.rows.push({
      file: path.relative(root, test.location.file).split(path.sep).join('/'),
      project: test.parent.project()?.name ?? '',
      title: test.titlePath().slice(3).join(' > '),
      status: result.status,
      milliseconds: result.duration,
      workerIndex: result.workerIndex,
    });
  }

  onEnd(result: FullResult): void {
    const config = this.config;
    // `--list` and runs that select no test leave nothing to record.
    if (config === undefined || this.rows.length === 0) return;
    const configName = path
      .basename(config.configFile ?? 'playwright.config.ts')
      .replace(/^playwright\.?/u, '')
      .replace(/\.?config\.[cm]?[jt]s$/u, '');
    const stamp = new Date(this.started).toISOString().replaceAll(/[:.]/gu, '-');
    const directory = path.resolve(
      process.env.VS_HEADED_TIMING_DIR ?? path.join(this.repository(), 'artifacts/headed-timing'),
    );
    const wallMilliseconds = Date.now() - this.started;
    const header = ['file', 'project', 'title', 'status', 'ms', 'worker'].join('\t');
    const lines = this.rows.map((row) =>
      [
        field(row.file),
        field(row.project),
        field(row.title),
        row.status,
        String(Math.round(row.milliseconds)),
        String(row.workerIndex),
      ].join('\t'),
    );
    const totals = new Map<string, { tests: number; milliseconds: number }>();
    for (const row of this.rows) {
      const key = `${row.file}\t${row.project}`;
      const total = totals.get(key) ?? { tests: 0, milliseconds: 0 };
      total.tests += 1;
      total.milliseconds += row.milliseconds;
      totals.set(key, total);
    }
    const summary = {
      schema: 'headed-timing-v1',
      config: path.basename(config.configFile ?? ''),
      startedUtc: new Date(this.started).toISOString(),
      status: result.status,
      workers: config.workers,
      wallMilliseconds,
      tests: this.rows.length,
      testMilliseconds: Math.round(this.rows.reduce((sum, row) => sum + row.milliseconds, 0)),
      specs: [...totals]
        .map(([key, total]) => {
          const [file = '', project = ''] = key.split('\t');
          return {
            file,
            project,
            tests: total.tests,
            milliseconds: Math.round(total.milliseconds),
          };
        })
        .sort((a, b) => b.milliseconds - a.milliseconds),
    };
    try {
      mkdirSync(directory, { recursive: true });
      const base = path.join(directory, `${stamp}-${configName || 'default'}`);
      writeFileSync(`${base}.tsv`, `${header}\n${lines.join('\n')}\n`);
      writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, 2)}\n`);
      const minutes = (milliseconds: number) => (milliseconds / 60_000).toFixed(1);
      console.log(
        `\nheaded timing: ${String(this.rows.length)} tests, wall ${minutes(wallMilliseconds)} min, ` +
          `${String(config.workers)} worker(s); ${base}.json`,
      );
      for (const spec of summary.specs.slice(0, 8))
        console.log(
          `  ${minutes(spec.milliseconds).padStart(6)} min  ${spec.project.padEnd(12)} ${spec.file}`,
        );
    } catch (error) {
      // Timing is a convenience: a failed write must not change the run's outcome.
      console.warn(`headed timing not written: ${String(error)}`);
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
