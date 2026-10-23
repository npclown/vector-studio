import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { runControls } from './e3-a04/controls.js';

it('scratch', () => {
  const out: string[] = [];
  for (const id of process.env.CTRL?.split(',') ?? []) {
    const t = performance.now();
    const r = runControls([id])[0]!;
    out.push(`${r.id} ok=${r.ok} ${r.observed} | ${r.detail} | ${Math.round(performance.now() - t)}ms`);
    writeFileSync('D:/GIT/vector-studio/.claude/worktrees/agent-a8368ea4adc31b564/.probe.txt', out.join('\n'));
  }
}, 3_000_000);
