import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { T03_PINNED } from './extent-t03/report.js';

/**
 * P3.1p T03: T02, T01, O02 and pinned P3.1m/R0a/R3 files stay byte-unchanged
 * (docs/plans/p3-r2-tiling-rev4-contract.md, "T03 evidence"). The reference is the archived T02
 * report's sources table, which hashes every one of them.
 */

const T02_REPORT = 'docs/evidence/p3.1p-t02/report.json';

const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex');

describe('P3.1p T03 pinned sources', () => {
  it('match the archived T02 sources table', () => {
    const archived = (
      JSON.parse(readFileSync(T02_REPORT, 'utf8')) as { sources: Record<string, string> }
    ).sources;
    for (const path of T03_PINNED) {
      expect(archived[path], path).toBeDefined();
      expect(sha256(path), path).toBe(archived[path]);
    }
  });
});
