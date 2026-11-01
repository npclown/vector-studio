// MVP M8 contract, M8-N3 (M8-U6): the next-host Playwright configs of a checkout and the projects
// each runs, headed and smoke, with the viewport and device scale factor Playwright gives each
// (the project's `use`, device presets included, over the config's). `tooling/m8-n3-measure.mjs`
// measures each; tests/unit/m8-u6-next-host.test.ts checks that each config states its viewport.
// Node strips the configs' TypeScript types; `@playwright/test` resolves from the checkout.
//
//   node tooling/m8-n3-configs.mjs [--root <checkout>]   prints the rows as JSON
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The next-host configs of a checkout, sorted by file name. */
export async function nextHostConfigs(root) {
  const names = await readdir(root);
  const extra = new Set([
    'playwright.m6c-u0-zoom.config.ts',
    'playwright.m6c-observe.config.ts',
    'playwright.e26.config.ts',
  ]);
  return names
    .filter((name) => /^playwright\..*next-host.*\.config\.ts$/u.test(name) || extra.has(name))
    .sort();
}

/**
 * The projects of one config, headed and smoke: the file is imported twice, once without and
 * once with its `*_CHROMIUM` variables set (each config switches to its smoke project on them).
 * Node strips the TypeScript types; `@playwright/test` resolves from the checkout.
 */
export async function projectsOf(root, file) {
  const source = await readFile(path.join(root, file), 'utf8');
  const variables = [...new Set(source.match(/(?<=process\.env\.)[A-Z0-9_]+_CHROMIUM/gu) ?? [])];
  const url = pathToFileURL(path.join(root, file)).href;
  const load = async (smoke) => {
    const saved = variables.map((name) => [name, process.env[name]]);
    for (const name of variables) {
      if (smoke) process.env[name] = '/measure/smoke';
      else delete process.env[name];
    }
    try {
      return (await import(`${url}?${smoke ? 'smoke' : 'headed'}`)).default;
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
  const rows = [];
  for (const smoke of variables.length === 0 ? [false] : [false, true]) {
    const config = await load(smoke);
    for (const project of config.projects ?? []) {
      // m6c-observe's raster projects load the playground, not next-host.
      const testDir = project.testDir ?? config.testDir ?? '';
      if (/tests[/\\]gpu/u.test(testDir)) continue;
      const use = { ...config.use, ...project.use };
      // A config whose smoke switch keeps the same project (m6c-u0-zoom) lists it once.
      if (rows.some((row) => row.project === project.name)) continue;
      rows.push({
        config: file,
        project: project.name,
        // As Playwright merges them: the project's `use` (device presets included) wins.
        viewport: use.viewport,
        deviceScaleFactor: use.deviceScaleFactor ?? 1,
        bench: file === 'playwright.e26.config.ts',
      });
    }
  }
  return rows;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const index = process.argv.indexOf('--root');
  const root = path.resolve(index < 0 ? process.cwd() : process.argv[index + 1]);
  const rows = [];
  for (const file of await nextHostConfigs(root)) rows.push(...(await projectsOf(root, file)));
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}
