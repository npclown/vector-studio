import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeCase, fill, rect, polygon } from './e3-a04/oracle-cases.js';
import { measureCase } from './e3-a04/harness.js';
import { fanTriangles, meshFromTriangles, syntheticPorts } from './e3-a04/synthetic.js';

describe('smoke', () => {
  it('rectangle', () => {
    const r = rect(0, 0, 16, 8);
    const kase = makeCase({ ...polygon(r), paint: fill(), t: [100, 100], c: [0, 0] });
    const mesh = meshFromTriangles(fanTriangles(r));
    const row = measureCase(kase, syntheticPorts(mesh));
    writeFileSync('D:/GIT/vector-studio/.claude/worktrees/agent-a8368ea4adc31b564/.probe.txt', JSON.stringify(row, null, 1));
    expect(row.status).toBe('pass');
  });
});
