// MVP M4 contract, M4-A04 (unit M4-U2, note 7): records `projectPage` of every committed
// well-formed pre-v6 fixture at a built checkout of M4-U1's merge base, the baseline that
// `tests/unit/m4-u2-projection.test.ts` compares migrated projections with.
//
// Usage, from this repository:
//   git worktree add --detach <dir> ea41bb8
//   (cd <dir> && pnpm install --frozen-lockfile && pnpm build)
//   node tooling/record-m4-a04-baseline.mjs <dir> tests/fixtures/m4-appearance/projection-baseline.json
//   git worktree remove <dir>
//
// The fixtures are read from <dir>/tests/fixtures (documents and envelope documents below v6,
// `malformed/` directories excluded); custom nodes project as the unit triangle.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RECORDED_AT = 'ea41bb8';
const NOTE =
  "projectPage of every committed well-formed pre-v6 fixture (documents and envelope documents, malformed/ excluded) at M4-U1's merge base; custom nodes project as the unit triangle M 0 0 L 1 0 L 0.5 1 Z (M4-A04)";

const [checkout, output] = process.argv.slice(2);
if (checkout === undefined || output === undefined) {
  console.error('usage: node tooling/record-m4-a04-baseline.mjs <built checkout> <output.json>');
  process.exit(2);
}
const root = path.resolve(checkout);
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const { parseDocument } = await load('packages/model/dist/index.js');
const { projectPage } = await load('packages/editor-core/dist/projector.js');

const unitTriangle = {
  verbs: ['move', 'line', 'line', 'close'],
  points: [0, 0, 1, 0, 0.5, 1],
  fillRule: 'nonzero',
};
const custom = (node) => (node.type === 'custom' ? unitTriangle : null);

const fixtures = path.join(root, 'tests/fixtures');
const out = {};
for (const entry of readdirSync(fixtures, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  const file = path
    .relative(fixtures, path.join(entry.parentPath, entry.name))
    .split(path.sep)
    .join('/');
  if (file.split('/').includes('malformed')) continue;
  let value;
  try {
    value = JSON.parse(readFileSync(path.join(fixtures, file), 'utf8'));
  } catch {
    continue;
  }
  const document = typeof value?.schemaVersion === 'number' ? value : value?.document;
  if (typeof document?.schemaVersion !== 'number' || document.schemaVersion > 5) continue;
  const result = parseDocument(JSON.stringify(document));
  if (!result.ok) {
    out[file] = { error: result.code };
    continue;
  }
  const pages = {};
  for (const page of result.document.pages) {
    const projection = projectPage(result.document, page.id, custom);
    pages[page.id] = {
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
      units: projection.units,
      invalid: projection.invalid,
    };
  }
  out[file] = pages;
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(
  output,
  JSON.stringify({ recordedAt: RECORDED_AT, note: NOTE, fixtures: sorted }) + '\n',
);
console.log(`${Object.keys(sorted).length} fixtures recorded to ${output}`);
