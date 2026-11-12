import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateM9V2Document } from '../m9/document';
import { loadScenarioDocument } from './scenarios';

// E26-U1c (E26 contract, section 3.3): before a harness run, write the two scenario documents
// the host's bench loader serves (apps/next-host/app/e26-bench-doc.json/route.ts) from U1a's
// generators, so the page loads exactly what the configuration hash describes. M9-U1 adds the v2
// document (`doc=m9-v2`), written from its generator alone (its layouts are not needed here).
// E41-U7c adds `doc=e41-cards` (the effects benchmark scene, E41 contract section 5.6); V35-U5 adds `doc=v35-cards`
// (the fills and blend benchmark scene, V35-A10); V36-U4 adds `doc=v36-glass` (the inner shadow and
// background blur benchmark scene, V36-A10).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function setup(): void {
  const directory = path.join(root, '.tools/e26/docs');
  mkdirSync(directory, { recursive: true });
  for (const doc of ['m1-a13', 'stress', 'e41-cards', 'v35-cards', 'v36-glass'] as const) {
    const { generated } = loadScenarioDocument(doc);
    writeFileSync(path.join(directory, `${doc}.json`), JSON.stringify(generated));
  }
  writeFileSync(path.join(directory, 'm9-v2.json'), JSON.stringify(generateM9V2Document()));
}
