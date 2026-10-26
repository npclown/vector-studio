import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

// Observed Windows CI seconds per file (Validate run 40272086937). Only files over 10 s are
// listed; every other file counts as DEFAULT_SECONDS. The weights only balance CI shards:
// a stale entry makes one shard slower, never skips a file.
const SECONDS: Readonly<Record<string, number>> = {
  'tests/geometry/p3-fill-ladder-analysis.test.ts': 316,
  'tests/geometry/native-e8-corner.test.ts': 213,
  'tests/geometry/p3-fill-ladder-oracle.test.ts': 132,
  'tests/geometry/position-certificate.test.ts': 82,
  'tests/geometry/stroke-oracle.test.ts': 51,
  'tests/geometry/extent-t03-local.test.ts': 45,
  'tests/geometry/extent-t01-core.test.ts': 37,
  'tests/geometry/position-certificate-r3.test.ts': 26,
  'tests/geometry/e3-a04-oracle.test.ts': 24,
  'tests/geometry/e3-a04-harness.test.ts': 20,
  'tests/geometry/position-certificate-r0a.test.ts': 18,
  'tests/geometry/p3-b0-spike-analysis.test.ts': 16,
  'tests/geometry/extent-t02-clearance.test.ts': 15,
  'tests/geometry/coverage-o02.test.ts': 12,
  'tests/geometry/coverage-oracle.test.ts': 12,
  'tests/geometry/coverage-o02-shader-emulation.test.ts': 11,
};
const DEFAULT_SECONDS = 2;

// Greedy longest-first partition: deterministic for a given file list and shard count.
class DurationSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return Promise.resolve(files);
    const weighted = files
      .map((spec) => {
        const key = path.relative(root, spec.moduleId).split(path.sep).join('/');
        return { spec, key, seconds: SECONDS[key] ?? DEFAULT_SECONDS };
      })
      .sort((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const loads = Array.from({ length: shard.count }, () => 0);
    const selected: TestSpecification[] = [];
    for (const { spec, seconds } of weighted) {
      const least = Math.min(...loads);
      const lightest = loads.indexOf(least);
      loads[lightest] = least + seconds;
      if (lightest === shard.index - 1) selected.push(spec);
    }
    return Promise.resolve(selected);
  }
}

export default defineConfig({
  test: {
    include: ['tests/geometry/**/*.test.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
    sequence: { sequencer: DurationSequencer },
  },
});
