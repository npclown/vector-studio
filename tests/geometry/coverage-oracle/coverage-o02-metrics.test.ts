import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildO02MetricsFiles,
  METRICS_DPR3_FILE,
  METRICS_FILE,
  O02_CAPTURE_INDEX_SCHEMA,
} from './capture-schema-o02.js';

/**
 * P3.1o O02 offline metrics (`pnpm coverage:p3-o02`). Both cases are gated by environment and skip
 * in `pnpm test:geometry`:
 *
 * - P3_O02_CAPTURE=<dir>: for every O02 capture-index.json at or below <dir>, write metrics.json
 *   (and metrics-dpr3.json when DPR 3 parts are present) next to it with an exclusive create.
 * - P3_O02_REPLAY=<dir>: recompute and require byte equality with every existing metrics file;
 *   metrics-dpr3.json is checked whenever DPR 3 parts are present.
 */

const capture = process.env.P3_O02_CAPTURE;
const replay = process.env.P3_O02_REPLAY;
const TIMEOUT = 3_600_000;

/** Directories at or below `root` holding an O02 capture-index.json, sorted. */
function o02CaptureDirectories(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    const index = path.join(directory, 'capture-index.json');
    if (existsSync(index)) {
      const schema = (JSON.parse(readFileSync(index, 'utf8')) as { schema?: unknown }).schema;
      if (schema === O02_CAPTURE_INDEX_SCHEMA) found.push(directory);
    }
    for (const name of readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      if (statSync(child).isDirectory()) visit(child);
    }
  };
  visit(root);
  return found;
}

describe('P3.1o O02 offline coverage metrics', () => {
  it.skipIf(!capture)(
    'writes metrics.json next to every capture index',
    () => {
      const directories = o02CaptureDirectories(path.resolve(capture!));
      expect(directories.length).toBeGreaterThan(0);
      for (const directory of directories)
        for (const [file, text] of buildO02MetricsFiles(directory)) {
          writeFileSync(path.join(directory, file), text, { flag: 'wx' });
          expect(readFileSync(path.join(directory, file), 'utf8')).toBe(text);
          console.log(`P3 O02 metrics WRITE ${path.join(directory, file)}`);
        }
    },
    TIMEOUT,
  );

  it.skipIf(!replay)(
    'replays every metrics file byte for byte',
    () => {
      const directories = o02CaptureDirectories(path.resolve(replay!));
      expect(directories.length).toBeGreaterThan(0);
      for (const directory of directories) {
        const files = buildO02MetricsFiles(directory);
        expect(files.map(([file]) => file)).toContain(METRICS_FILE);
        for (const [file, text] of files) {
          const expected = readFileSync(path.join(directory, file), 'utf8');
          expect(text === expected, `${directory}/${file}`).toBe(true);
          console.log(`P3 O02 metrics REPLAY ${path.join(directory, file)}`);
        }
        if (!files.some(([file]) => file === METRICS_DPR3_FILE))
          console.log(
            `P3 O02 metrics REPLAY ${directory}: no DPR 3 parts; ${METRICS_DPR3_FILE} skipped`,
          );
      }
    },
    TIMEOUT,
  );
});
