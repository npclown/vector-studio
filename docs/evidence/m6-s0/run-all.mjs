/* global URL */
// M6-S0: runs (a) to (d) in one browser channel against one dev server. Each script writes its
// own report to OUT_DIR (default docs/evidence/m6-s0/runs). See README.md.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from './lib.mjs';

const scripts = ['layout-throughput.mjs', 'dpr-layout.mjs', 'fallback.mjs', 'ink-boxes.mjs'];
const server = await serve();
let failed = 0;
try {
  for (const script of scripts) {
    console.log(`\n=== ${script} ===`);
    // Asynchronous: the dev server runs in this process and must keep serving.
    const status = await new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
        stdio: 'inherit',
        env: { ...process.env, BASE: server.base },
      });
      child.on('exit', (code) => resolve(code));
    });
    if (status !== 0) failed += 1;
  }
} finally {
  await server.close();
}
if (failed) {
  console.error(`${failed} script(s) failed`);
  process.exitCode = 1;
}
