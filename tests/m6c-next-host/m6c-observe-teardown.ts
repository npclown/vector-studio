import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  rasterFrameRow,
  summaryMarkdown,
  type RasterFrameRow,
  type TypingReport,
} from './m6c-observe';

// M6c-U5: the teardown of playwright.m6c-observe.config.ts. It reads the run's reports under
// `M6C_OBSERVE_DIR` (typing/<project>.json, and the E28 spec's
// e28/<run>/<project>/handoff-dpr-<n>/report.json), prints the summary tables and saves them as
// summary.md beside the reports. It judges nothing.

function files(directory: string, match: (name: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...files(full, match));
    else if (match(full)) found.push(full);
  }
  return found.sort();
}

export default function teardown(): void {
  const root = process.env.M6C_OBSERVE_DIR;
  if (root === undefined || !existsSync(root)) return;
  const typing = files(path.join(root, 'typing'), (name) => name.endsWith('.json')).map(
    (file) => JSON.parse(readFileSync(file, 'utf8')) as TypingReport,
  );
  const raster: RasterFrameRow[] = files(path.join(root, 'e28'), (name) =>
    /handoff-dpr-\d+[/\\]report\.json$/u.test(name),
  ).map((file) => {
    // <run>/<project>/handoff-dpr-<n>/report.json
    const project = path.basename(path.dirname(path.dirname(file)));
    return rasterFrameRow(project, JSON.parse(readFileSync(file, 'utf8')));
  });
  const markdown = summaryMarkdown(typing, raster);
  writeFileSync(path.join(root, 'summary.md'), markdown);
  console.log(`\n${markdown}\nSaved in ${path.join(root, 'summary.md')}`);
}
