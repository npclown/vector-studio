import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMetricsText, loadCaptureDirectory } from './capture-schema.js';

/**
 * P3.1o O01 offline metrics (`pnpm coverage:p3-o01`). Both cases are gated by environment and skip in
 * `pnpm test:geometry`:
 *
 * - P3_COVERAGE_CAPTURE=<dir>: compute metrics.json from <dir>/capture-index.json or
 *   <dir>/capture.json and write it next to the capture with an exclusive create.
 * - P3_COVERAGE_REPLAY=<dir>: recompute and require byte equality with <dir>/metrics.json.
 */

const capture = process.env.P3_COVERAGE_CAPTURE;
const replay = process.env.P3_COVERAGE_REPLAY;
const TIMEOUT = 1_200_000;

describe('P3.1o O01 offline coverage metrics', () => {
  it.skipIf(!capture)(
    'writes metrics.json from the capture',
    () => {
      const directory = path.resolve(capture!);
      const text = buildMetricsText(loadCaptureDirectory(directory));
      writeFileSync(path.join(directory, 'metrics.json'), text, { flag: 'wx' });
      expect(readFileSync(path.join(directory, 'metrics.json'), 'utf8')).toBe(text);
    },
    TIMEOUT,
  );

  it.skipIf(!replay)(
    'replays metrics.json byte for byte',
    () => {
      const directory = path.resolve(replay!);
      const expected = readFileSync(path.join(directory, 'metrics.json'), 'utf8');
      expect(buildMetricsText(loadCaptureDirectory(directory)) === expected).toBe(true);
    },
    TIMEOUT,
  );
});
