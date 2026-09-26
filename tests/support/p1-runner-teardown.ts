import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { p1Source } from './p1-evidence.js';
import { writeP1Aggregate } from './p1-runner-aggregate.js';

export default function p1RunnerTeardown(): void {
  const root = process.env.P1_RUNNER_OUTPUT_DIR;
  if (root === undefined || !existsSync(root)) return;

  const findings: string[] = [];
  let source: ReturnType<typeof p1Source> | undefined;
  let error: string | undefined;
  try {
    source = p1Source();
  } catch (caught) {
    error = String(caught);
    findings.push(`Run-end source capture failed: ${error}`);
  }
  try {
    writeFileSync(
      path.join(root, 'source-end.json'),
      `${JSON.stringify(
        {
          schema: 'p1-observed-run-source/v1',
          createdAt: new Date().toISOString(),
          profile: process.env.P1_RUNNER_PROFILE,
          ...(source === undefined ? { error } : { source }),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
  } catch (caught) {
    findings.push(`Run-end source record could not be written: ${String(caught)}`);
  }

  writeP1Aggregate(root, findings);
}
