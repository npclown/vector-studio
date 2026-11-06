// CI scope for the geometry jobs of `.github/workflows/validate.yml` (user decision 2026-11-06,
// thread "Improve the editor UI usability"): a pull request whose every changed file lies in a
// path the geometry suites never read skips the native Rust, WASM identity and geometry vitest
// jobs. The list is an allow-list, so a new or unknown path still runs them. The geometry suites
// import `editor-core`, `model`, `contracts`, the renderers, `apps/playground`, `tests/support`
// and many `docs/` contracts and records, so none of those is listed. A push to `main` always
// runs every job.
//
// Usage: node tooling/ci-geometry-scope.mjs <base-sha> <head-sha>  (prints `geometry=true|false`
// for `$GITHUB_OUTPUT`).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Paths the geometry suites never import or read (prefixes end in `/`). */
export const GEOMETRY_FREE = Object.freeze([
  'apps/next-host/',
  'packages/ui/',
  'packages/react/',
  'packages/persistence-idb/',
  'tests/unit/',
  /^tests\/m\d+[a-z]?-next-host\//u,
  'tests/p5-next-host/',
  /^docs\/plans\/(viz-|mvp-)[^/]*\.md$/u,
  'docs/plans/d9-visualization-track.md',
  'docs/host-api.md',
]);

/**
 * Whether `file` (a repository path with `/`) is in the geometry-free list. A `package.json`
 * never is: the geometry jobs run `pnpm build`, which runs every package's build script.
 */
export function geometryFree(file) {
  if (file === 'package.json' || file.endsWith('/package.json')) return false;
  return GEOMETRY_FREE.some((entry) =>
    typeof entry === 'string'
      ? entry.endsWith('/')
        ? file.startsWith(entry)
        : file === entry
      : entry.test(file),
  );
}

/** Whether the geometry jobs must run for `files`: any file outside the list, or no files. */
export function needsGeometry(files) {
  return files.length === 0 || files.some((file) => !geometryFree(file));
}

/**
 * The git arguments listing the PR's changed files. `--no-renames` lists both sides of a move,
 * so a file moved out of a geometry path onto the list still counts its old path.
 */
export function diffArgs(base, head) {
  return ['diff', '--name-only', '--no-renames', `${base}...${head}`];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, head] = process.argv.slice(2);
  let geometry = true;
  if (base && head) {
    const out = execFileSync('git', diffArgs(base, head), { encoding: 'utf8' });
    const files = out.split('\n').filter((line) => line.length > 0);
    geometry = needsGeometry(files);
    console.error(`${files.length} changed files; geometry jobs: ${geometry ? 'run' : 'skip'}`);
  }
  console.log(`geometry=${geometry}`);
}
