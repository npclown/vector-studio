import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { T02_PINNED } from './extent-t02/report.js';

/**
 * P3.1p T02: the extent-t01 modules and every pinned P3.1m, R0a, R3, T01 and O02 file T02 imports
 * stay byte-unchanged (docs/plans/p3-r2-tiling-contract.md, "Report and replay").
 */

const T01_REPORT_SOURCES = 'docs/evidence/p3.1p-t01/report.json';
/** coverage-oracle/exterior.ts as integrated with O02 (not in the T01 sources table). */
const EXTERIOR_SHA256 = '36fc7739ce149de8016714bbcd0601dab84e70f9fb0e6d4e502b5211904da0f7';

const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex');

describe('P3.1p T02 pinned sources', () => {
  it('match the archived T01 sources table and the O02 exterior hash', () => {
    const archived = (
      JSON.parse(readFileSync(T01_REPORT_SOURCES, 'utf8')) as { sources: Record<string, string> }
    ).sources;
    for (const path of T02_PINNED) {
      const expected =
        path === 'tests/geometry/coverage-oracle/exterior.ts' ? EXTERIOR_SHA256 : archived[path];
      expect(expected, path).toBeDefined();
      expect(sha256(path), path).toBe(expected);
    }
  });
});
