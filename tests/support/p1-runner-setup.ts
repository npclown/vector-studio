import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { p1Source } from './p1-evidence.js';

export default function p1RunnerSetup(): void {
  const root = process.env.P1_RUNNER_OUTPUT_DIR;
  if (root === undefined) return;
  if (!existsSync(root)) throw new Error('P1 runner output directory was not reserved.');
  writeFileSync(
    path.join(root, 'source-start.json'),
    `${JSON.stringify(
      {
        schema: 'p1-observed-run-source/v1',
        createdAt: new Date().toISOString(),
        profile: process.env.P1_RUNNER_PROFILE,
        source: p1Source(),
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
}
