import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenarioDocument } from './scenarios';

// E26-U1c (E26 contract, section 3.3): before a harness run, write the two scenario documents
// the host's bench loader serves (apps/next-host/app/e26-bench-doc.json/route.ts) from U1a's
// generators, so the page loads exactly what the configuration hash describes.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function setup(): void {
  const directory = path.join(root, '.tools/e26/docs');
  mkdirSync(directory, { recursive: true });
  for (const doc of ['m1-a13', 'stress'] as const) {
    const { generated } = loadScenarioDocument(doc);
    writeFileSync(path.join(directory, `${doc}.json`), JSON.stringify(generated));
  }
}
