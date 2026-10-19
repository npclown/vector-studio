// B0R unit U0: pipeline identity against the merge base, `pnpm test:p3-fill-identity`.
// Frozen by docs/plans/p3-b0r-kernel-performance-contract.md section 7 (O4, O5, O7, the
// randomized corpus and its coverage floors, profiles and run times) and section 9 row U0.
//
// Extended by Alt-A1 unit AL-U2 (docs/plans/p3-alt-a1-fill-ladder-contract.md section 4.4):
// the reviewed test-file allow-list, the revision check, the data cases of
// `p3-fill-ladder-random/v1` and the `--revision-change` mode.
//
// Full run (default, plain mode):
//   node tooling/compare-p3-fill-identity.mjs [--base <ref>] [--threads <n>]
//     [--allow-test-change <path>]... [--revision-change]
// 1. O5: no existing test file changed except those listed with the repeatable
//    `--allow-test-change <path>` (a listed file that is not changed, or a changed file that is
//    not listed, fails; the list and the allowed `git diff --name-status` lines are written to
//    the run directory), and every inline `#[cfg(test)] mod <name> { ... }` block of each
//    modified kernel source file is byte-identical to the merge base.
// 2. Builds the merge base from `git archive` into a temporary directory with the pinned
//    toolchain, as compare-p2-wasm.mjs does, after the bootstrap overlay: the harness file
//    `p3_b0r_identity.rs` and its `#[cfg(test)] mod` declaration are copied from this working
//    tree (a no-op once the merge base contains them unchanged).
// 3. Native layer: the release-profile ignored test `p3_b0r_identity::dump_native_digests`
//    on both trees over the B0 framed corpus (every cell and path), `p3-b0r-random/v1` and
//    `p3-fill-ladder-random/v1`: all four `CubicFillWorkspace` entries plus the V2 cascade
//    through `FillEngine`.
// 4. WASM layer: `fill_v0` output bytes through both release WASMs in Node, over the B0
//    decision cells, the first 2,000 randomized paths in corpus order with their stratified
//    superset, and every `p3-fill-ladder-random/v1` path. Both kernels must report the same
//    `fill_v0_revision()` in plain mode, and the branch the merge base's plus one with
//    `--revision-change`.
// 5. Release-profile oracles: every ignored kernel test whose name contains `b0r_oracle_full`
//    (contract section 7: O1 at full size and the later units' full-size oracles), on this tree
//    only, with their output saved in the run directory.
// 6. Every digest must be equal, every entry call must allocate nothing (O7), the randomized
//    corpus must meet its coverage floors, and a tampered digest must be reported (self-check).
//
// `--revision-change` (AL-U3 only) replaces step 6's digest equality: the native entry layer
// must still be identical (AL-I1), and every native cascade case and WASM case is classified by
// the branch's rung record (`fill_ladder_identity::dump_rungs`, branch only) as unchanged
// (rung 1, equal bytes), fast-identical (rung 0, equal bytes), changed-fast (rung 0, the merge
// base `ok` with other bytes) or newly-admitted (rung 0, the merge base failed). A rung-1 case
// whose bytes differ, a case missing from the rung record, or a rung-0 case that is not `ok`
// fails. Every case of the last three classes must pass SL-O1 and SL-O2 on the
// `emit_fill_ladder_dump` hand-off of its path. The run writes a change manifest (case, class,
// old status, reason) and its SHA-256, and checks that a seeded unexpected change fails.
//
// Re-comparison of a finished run, with an optional tampered digest:
//   node tooling/compare-p3-fill-identity.mjs --compare-only <run-dir> [--tamper <case>]
//     [--revision-change]
// Self-test of the revision-change mode on a synthetic run directory (no kernel needed):
//   node tooling/compare-p3-fill-identity.mjs --self-test
/* global WebAssembly */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.tools');
const cargoHome = path.join(cache, 'rust/cargo');
const rustupHome = path.join(cache, 'rust/rustup');
const rustup = path.join(cargoHome, process.platform === 'win32' ? 'bin/rustup.exe' : 'bin/rustup');
const temporary = path.join(cache, 'geometry-tmp');
const BRANCH_TARGET = path.join(cache, 'geometry-build');
const RUST = {
  release: '1.94.1',
  commit: 'e408947bfd200af42db322daf0fadfe7e26d3bd1',
  host: 'x86_64-pc-windows-msvc',
};
const KERNEL = 'packages/geometry-wasm/kernel';
const KERNEL_SRC = `${KERNEL}/src`;
const HARNESS = `${KERNEL_SRC}/p3_b0r_identity.rs`;
const HARNESS_MODULE = 'p3_b0r_identity';
const HARNESS_TEST = `${HARNESS_MODULE}::dump_native_digests`;
/** Branch-only rung record and oracle hand-off (Alt-A1 AL-U2); never copied by the overlay. */
const RUNG_TEST = 'fill_ladder_identity::dump_rungs';
const DUMP_TEST = 'fill_ladder_dump_tests::emit_fill_ladder_dump';
const WASM_RELATIVE = 'wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm';
/** Frozen B0 corpus SHA-256 (B0R contract section 8). */
export const B0_CORPUS_SHA256 = '206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796';
/** SHA-256 of `p3-b0r-random/v1`, pinned by U0 (contract section 7). */
export const RANDOM_CORPUS_SHA256 =
  'a1902d0f9a0dadf50abe930791e84d3b8a3fcf0bcf6bb37423d400690673ca9d';
/** SHA-256 of `p3-fill-ladder-random/v1` in the `P3BRRND1` frame, pinned by Alt-A1 AL-U2. */
export const LADDER_CORPUS_SHA256 =
  'a597510de7fb1850daf89e98b398f642ded3d5d6bc1e3c5178bbd47e7e947bbc';
/** The contract's literal WASM selection: the first 2,000 randomized paths in corpus order. */
export const WASM_RANDOM_PATHS = 2_000;
/** Stratified superset (U0 review): at least this many paths of every family beyond the first. */
export const WASM_STRATUM_PATHS = 200;
const SCALED_BELOW = 2 ** -20;
const SCALED_ABOVE = 2 ** 30;
const WASM_INPUT_BYTES = 64 * 1024;
const WASM_OUTPUT_BYTES = 1024 * 1024;
const BATCH_OK = 0;
const FILL_INPUT_MAGIC = 0x3046_4756;
const B0_EXPONENT = -3;
/** The one family of `p3-fill-ladder-random/v1` (tests/geometry/p3-fill-ladder/corpus.ts). */
const LADDER_FAMILY_ID = 'L1-generic-ladder';

// ---------------------------------------------------------------------------------------------
// Pure helpers, exported for tests/unit/p3-b0r-identity.test.ts.

/**
 * Inline test modules of a rustfmt-formatted Rust source: every `#[cfg(test)]` line followed,
 * after optional attribute lines, by `mod <name> {`, through the first later line that is the
 * closing brace at the `mod` line's indentation. Returns a Map of module name to block text.
 */
export function inlineTestModules(source) {
  const lines = source.split('\n');
  const modules = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*#\[cfg\(test\)\]\s*$/u.test(lines[index])) continue;
    let cursor = index + 1;
    while (cursor < lines.length && /^\s*#\[.*\]\s*$/u.test(lines[cursor])) cursor += 1;
    const header = /^(\s*)(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/u.exec(
      lines[cursor] ?? '',
    );
    if (!header) continue;
    const close = `${header[1]}}`;
    let end = cursor + 1;
    while (end < lines.length && lines[end].trimEnd() !== close) end += 1;
    if (end >= lines.length) throw new Error(`Unterminated inline test module ${header[2]}`);
    if (modules.has(header[2])) throw new Error(`Duplicate inline test module ${header[2]}`);
    modules.set(header[2], lines.slice(index, end + 1).join('\n'));
    index = end;
  }
  return modules;
}

/** O5 inline-module check of one modified file; returns a list of failure strings. */
export function compareInlineTestModules(file, baseSource, branchSource) {
  const base = inlineTestModules(baseSource);
  const branch = inlineTestModules(branchSource);
  const failures = [];
  for (const name of new Set([...base.keys(), ...branch.keys()])) {
    if (!base.has(name)) failures.push(`${file}: inline test module ${name} added`);
    else if (!branch.has(name)) failures.push(`${file}: inline test module ${name} removed`);
    else if (base.get(name) !== branch.get(name))
      failures.push(`${file}: inline test module ${name} differs from the merge base`);
  }
  return failures;
}

/** Parses a native digest file: case, digest, allocations, code, crossings per line. */
export function parseNativeDigests(text) {
  const cases = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [name, digest, allocations, code, crossings, ...rest] = line.split('\t');
    if (rest.length > 0 || !/^[0-9a-f]{64}$/u.test(digest ?? '') || crossings === undefined)
      throw new Error(`Malformed digest line: ${line}`);
    if (cases.has(name)) throw new Error(`Duplicate case ${name}`);
    cases.set(name, {
      digest,
      allocations: Number(allocations),
      code,
      crossings: Number(crossings),
    });
  }
  return cases;
}

/** Compares two digest maps; returns missing, extra and differing case names, in order. */
export function compareDigests(base, branch) {
  const missing = [...base.keys()].filter((name) => !branch.has(name));
  const extra = [...branch.keys()].filter((name) => !base.has(name));
  const differing = [...base.keys()].filter(
    (name) => branch.has(name) && base.get(name).digest !== branch.get(name).digest,
  );
  return {
    missing,
    extra,
    differing,
    equal: missing.length + extra.length + differing.length === 0,
  };
}

/** A copy of `cases` with the digest of `name` altered in its first hex digit. */
export function tamper(cases, name) {
  const entry = cases.get(name);
  if (!entry) throw new Error(`Cannot tamper with unknown case ${name}`);
  const copy = new Map(cases);
  const first = entry.digest[0] === '0' ? '1' : '0';
  copy.set(name, { ...entry, digest: `${first}${entry.digest.slice(1)}` });
  return copy;
}

const CAP_CODE =
  /^(SourceLimit|CommandLimit|PointLimit|OwnerLimit|ContourLimit|CombinedByteLimit|EmissionStatus\(5\)|NO_MESH\(flat_status=5\)|path_status=5|Rounded\(\w*Limit\)|Topology\((WorkLimit|ByteLimit)\))$/u;

/** True for a cap-bound failure code (B0's CAP_CODES, every `*Limit`, and fill-v0 WORK_LIMIT). */
export function isCapFailure(code) {
  return CAP_CODE.test(code);
}

/**
 * Coverage of the randomized corpus over the native cases `rnd/<family>/<index>/<entry>`. A path
 * counts once per floor when any of its entries (or the cascade) shows the outcome; an `ok`
 * path has an entry returning a published nonempty mesh, and a crossing path an `ok` entry with
 * at least one proper crossing event.
 */
export function randomCoverage(cases) {
  const paths = new Map();
  const perEntry = {};
  for (const [name, entry] of cases) {
    const match = /^rnd\/([^/]+)\/(\d+)\/(.+)$/u.exec(name);
    if (!match) continue;
    const key = `${match[1]}/${match[2]}`;
    const flags = paths.get(key) ?? {
      ok: false,
      knotMismatch: false,
      unresolved: false,
      capFailure: false,
      okWithCrossings: false,
    };
    const ok = entry.code === 'OK' || entry.code === 'path_status=0';
    flags.ok ||= ok;
    flags.okWithCrossings ||= ok && entry.crossings > 0;
    flags.knotMismatch ||= entry.code === 'Topology(KnotMismatch)';
    flags.unresolved ||= entry.code === 'Topology(Unresolved)';
    flags.capFailure ||= isCapFailure(entry.code);
    paths.set(key, flags);
    const tally = (perEntry[match[3]] ??= {});
    tally[entry.code] = (tally[entry.code] ?? 0) + 1;
  }
  const counts = {
    paths: paths.size,
    ok: 0,
    knotMismatch: 0,
    unresolved: 0,
    capFailure: 0,
    okWithCrossings: 0,
  };
  for (const flags of paths.values())
    for (const key of Object.keys(flags)) if (flags[key]) counts[key] += 1;
  return { counts, perEntry };
}

/** Floors that `counts` misses, as strings. */
export function missedFloors(counts, floors) {
  return Object.entries(floors)
    .filter(([key, floor]) => counts[key] < floor)
    .map(([key, floor]) => `${key}: ${counts[key]} < ${floor}`);
}

/** One-path fill-v0 input (V2 contract section a). */
export function packFillInput(verbs, points, rule, exponent, requestId) {
  const requests = 48;
  const pathOffsets = requests + 16;
  const pointOffsets = pathOffsets + 8;
  const verbsOffset = pointOffsets + 8;
  const pointsOffset = Math.ceil((verbsOffset + verbs.length) / 8) * 8;
  const total = pointsOffset + 8 * points.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const header = [
    FILL_INPUT_MAGIC,
    0,
    total,
    1,
    verbs.length,
    points.length,
    requests,
    pathOffsets,
    pointOffsets,
    verbsOffset,
    pointsOffset,
    0,
  ];
  header.forEach((value, index) => view.setUint32(index * 4, value, true));
  view.setUint32(requests, requestId, true);
  view.setUint32(requests + 4, rule, true);
  view.setInt32(requests + 8, exponent, true);
  view.setUint32(pathOffsets + 4, verbs.length, true);
  view.setUint32(pointOffsets + 4, points.length, true);
  bytes.set(verbs, verbsOffset);
  points.forEach((value, index) => view.setFloat64(pointsOffset + 8 * index, value, true));
  return bytes;
}

/**
 * Randomized paths of the WASM layer, in corpus order. `corpus` is the generator output and
 * `crossingPaths` the set of `<family>/<index>` keys whose native `ok` cases have crossings.
 * Reasons: `first` (the contract's literal first 2,000 paths), then for every other family
 * `crossing` (all crossing paths), `exponent` (all non-default tolerance exponents), `scaled`
 * (all paths with a coordinate magnitude outside [2^-20, 2^30]) and `stride` (every tenth
 * index, then the next offsets, until the family has at least 200 selected paths).
 */
export function selectWasmRandomPaths(corpus, crossingPaths, defaultExponent = B0_EXPONENT) {
  const selected = [];
  let first = WASM_RANDOM_PATHS;
  for (const { family, paths } of corpus) {
    const reasons = new Map();
    for (let index = 0; index < paths.length && first > 0; index += 1, first -= 1)
      reasons.set(index, 'first');
    if (reasons.size < paths.length) {
      paths.forEach((item, index) => {
        if (reasons.has(index)) return;
        const magnitude = item.points.reduce((most, value) => Math.max(most, Math.abs(value)), 0);
        if (crossingPaths.has(`${family.id}/${index}`)) reasons.set(index, 'crossing');
        else if (item.exponent !== defaultExponent) reasons.set(index, 'exponent');
        else if (magnitude < SCALED_BELOW || magnitude > SCALED_ABOVE) reasons.set(index, 'scaled');
      });
      const stride = Math.max(1, Math.floor(paths.length / WASM_STRATUM_PATHS));
      for (let offset = 0; offset < stride && reasons.size < WASM_STRATUM_PATHS; offset += 1)
        for (
          let index = offset;
          index < paths.length && reasons.size < WASM_STRATUM_PATHS;
          index += stride
        )
          if (!reasons.has(index)) reasons.set(index, 'stride');
    }
    for (const index of [...reasons.keys()].sort((a, b) => a - b))
      selected.push({ family: family.id, index, path: paths[index], reason: reasons.get(index) });
  }
  return selected;
}

/** The native cascade case that a WASM case must equal (same request, same digest text). */
export function nativeCascadeName(wasmName) {
  const match = /^wasm\/(b0|rnd)\/(.+)$/u.exec(wasmName);
  if (!match) throw new Error(`Not a WASM case: ${wasmName}`);
  return `${match[1]}/${match[2]}/fill_v0_cascade`;
}

/** WASM-vs-native cascade comparison over the branch digests. */
export function compareWasmToNative(wasm, native) {
  const differing = [];
  const missing = [];
  for (const [name, entry] of wasm) {
    const counterpart = native.get(nativeCascadeName(name));
    if (!counterpart) missing.push(name);
    else if (counterpart.digest !== entry.digest) differing.push(name);
  }
  return { missing, extra: [], differing, equal: missing.length + differing.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// Alt-A1 AL-U2 pure helpers (contract section 4.4), exported for tests/unit/p3-b0r-identity.test.ts.

/** Command-line options; `--allow-test-change` repeats; `--revision-change` and `--self-test` take no value. */
export function parseArguments(args) {
  const options = {
    base: null,
    threads: null,
    compareOnly: null,
    tamper: null,
    allowTestChanges: [],
    revisionChange: false,
    selfTest: false,
  };
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === '--revision-change' || flag === '--self-test') {
      if (flag === '--revision-change') options.revisionChange = true;
      else options.selfTest = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    if (flag === '--base') options.base = value;
    else if (flag === '--threads') options.threads = Number.parseInt(value, 10);
    else if (flag === '--compare-only') options.compareOnly = value;
    else if (flag === '--tamper') options.tamper = value;
    else if (flag === '--allow-test-change')
      options.allowTestChanges.push(value.replaceAll('\\', '/'));
    else throw new Error(`Unknown argument ${flag}.`);
    index += 2;
  }
  if (options.tamper !== null && options.compareOnly === null)
    throw new Error('--tamper is accepted only with --compare-only.');
  if (options.selfTest && args.length !== 1)
    throw new Error('--self-test takes no other argument.');
  if (new Set(options.allowTestChanges).size !== options.allowTestChanges.length)
    throw new Error('--allow-test-change lists a path twice.');
  return options;
}

/**
 * O5 with the reviewed allow-list: `listing` holds `git diff --name-status` lines of the test
 * files. Added files pass. Every other line names an existing test file (the source path of a
 * rename or copy), which must be listed; every listed file must have such a line.
 */
export function checkTestFileChanges(listing, allowList) {
  const listed = new Set(allowList);
  const allowed = [];
  const failures = [];
  const changed = new Set();
  for (const line of listing) {
    const [status, ...paths] = line.split('\t');
    if (status.startsWith('A')) continue;
    const file = paths[0].replaceAll('\\', '/');
    changed.add(file);
    if (listed.has(file)) allowed.push(line);
    else failures.push(`existing test file changed: ${line}`);
  }
  for (const file of allowList)
    if (!changed.has(file)) failures.push(`allow-listed test file not changed: ${file}`);
  return { allowed, failures };
}

/** Section 4.4: equal revisions in plain mode, the merge base's plus one with --revision-change. */
export function checkRevisions(base, branch, revisionChange) {
  if (revisionChange)
    return branch === base + 1
      ? []
      : [`revision-change mode needs branch revision ${base + 1}, found ${branch}`];
  return branch === base ? [] : [`fill_v0_revision() differs: base ${base}, branch ${branch}`];
}

/** Parses the rung record: path, rung (0 or 1), reason, exact step and exact result per line. */
export function parseRungRecord(text) {
  const rungs = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [name, rung, reason, step, exact, ...rest] = line.split('\t');
    if (rest.length > 0 || exact === undefined || (rung !== '0' && rung !== '1'))
      throw new Error(`Malformed rung line: ${line}`);
    if ((rung === '0') !== (reason === '-')) throw new Error(`Rung and reason disagree: ${line}`);
    if (rungs.has(name)) throw new Error(`Duplicate rung path ${name}`);
    rungs.set(name, { rung: Number(rung), reason, step, exact });
  }
  return rungs;
}

const CASCADE_SUFFIX = '/fill_v0_cascade';
/** The one case that `--revision-change` exempts from identity, by exact name. */
export const FILL_ENGINE_META = 'meta/fill-engine-sizes';
const PATH_OK_CODE = 'path_status=0';

/** The rung-record path of a native cascade or WASM case, or null for an entry or meta case. */
export function rungPathOf(name) {
  if (name.startsWith('wasm/')) return name.slice('wasm/'.length);
  if (name.endsWith(CASCADE_SUFFIX)) return name.slice(0, -CASCADE_SUFFIX.length);
  return null;
}

/** The manifest's family of a path: `b0/<series>` (O1 and X count as series) or `rnd/<family>`. */
export function familyOf(path) {
  return path.split('/').slice(0, 2).join('/');
}

/**
 * Section 4.4's classification. `native` and `wasm` hold the base and branch digest maps,
 * `rungs` the branch's rung record. Entry and meta cases must be identical (AL-I1), except
 * `FILL_ENGINE_META`, whose change (the ladder's reservation in AL-U3) is recorded, not failed.
 * Returns every classified case in input order and the failures.
 */
export function classifyRevisionChange({ native, wasm, rungs }) {
  const failures = [];
  const cases = [];
  const metaDiffering = [];
  for (const [layer, { base, branch }] of [
    ['native', native],
    ['wasm', wasm],
  ]) {
    const comparison = compareDigests(base, branch);
    for (const name of comparison.missing)
      failures.push(`${layer}: case ${name} missing on the branch`);
    for (const name of comparison.extra) failures.push(`${layer}: case ${name} only on the branch`);
    for (const [name, old] of base) {
      const current = branch.get(name);
      if (current === undefined) continue;
      const path = rungPathOf(name);
      if (path === null) {
        if (old.digest === current.digest) continue;
        if (name === FILL_ENGINE_META) metaDiffering.push(name);
        else failures.push(`AL-I1: entry case ${name} differs from the merge base`);
        continue;
      }
      const rung = rungs.get(path);
      if (rung === undefined) {
        failures.push(`${name}: path ${path} missing from the rung record`);
        continue;
      }
      const equal = old.digest === current.digest;
      let kind;
      if (rung.rung === 1) {
        if (!equal) {
          failures.push(
            `${name}: rung 1 but the bytes differ from the merge base (${old.code} -> ${current.code})`,
          );
          continue;
        }
        kind = 'unchanged';
      } else if (current.code !== PATH_OK_CODE) {
        failures.push(`${name}: rung 0 but the branch status is ${current.code}`);
        continue;
      } else if (equal) kind = 'fast-identical';
      else kind = old.code === PATH_OK_CODE ? 'changed-fast' : 'newly-admitted';
      cases.push({
        case: name,
        layer,
        path,
        family: familyOf(path),
        class: kind,
        oldStatus: old.code,
        reason: rung.reason,
      });
    }
  }
  return { cases, failures, metaDiffering };
}

/** The paths that the oracles must validate: those of every class but unchanged. */
export function changedPaths(cases) {
  return [...new Set(cases.filter((item) => item.class !== 'unchanged').map((item) => item.path))];
}

/**
 * Every non-unchanged case's path must be in `validation` (path to { rung, failures }) as a
 * fast entry with no SL-O1 or SL-O2 failure.
 */
export function applyOracleValidation(cases, validation) {
  const failures = [];
  for (const path of changedPaths(cases)) {
    const result = validation.get(path);
    if (result === undefined) failures.push(`${path}: not validated by the oracles`);
    else if (result.rung !== 'fast') failures.push(`${path}: the dump took rung ${result.rung}`);
    else
      for (const failure of result.failures)
        if (failure.startsWith('SL-O1') || failure.startsWith('SL-O2'))
          failures.push(`${path}: ${failure}`);
  }
  return failures;
}

/** The change manifest (case, class, old status, reason), its SHA-256 and its counts. */
export function revisionManifest(cases) {
  const text = cases
    .map((item) => `${item.case}\t${item.class}\t${item.oldStatus}\t${item.reason}\n`)
    .join('');
  const counts = {};
  for (const item of cases) {
    const key = `${item.layer} ${item.family}`;
    counts[key] ??= { unchanged: 0, 'fast-identical': 0, 'changed-fast': 0, 'newly-admitted': 0 };
    counts[key][item.class] += 1;
  }
  return { text, sha256: createHash('sha256').update(text).digest('hex'), counts };
}

/** The seeded unexpected change: a rung-1 case's branch digest, tampered, must fail by name. */
export function revisionSelfCheck(input, name) {
  const layer = name.startsWith('wasm/') ? 'wasm' : 'native';
  const tampered = {
    ...input,
    [layer]: { ...input[layer], branch: tamper(input[layer].branch, name) },
  };
  const { failures } = classifyRevisionChange(tampered);
  return {
    case: name,
    detected: failures.some((failure) =>
      failure.startsWith(`${name}: rung 1 but the bytes differ`),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Process helpers.

function run(binary, args, options = {}) {
  console.log(`> ${path.basename(binary)} ${args.join(' ')}`);
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status ?? result.signal})`);
}

function capture(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${binary} ${args.join(' ')} failed`);
  return result.stdout;
}

const git = (...args) => capture('git', args).trim();

function cargoEnv(sourceRoot, targetDirectory, extra = {}) {
  return {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    CARGO_TARGET_DIR: targetDirectory,
    TEMP: temporary,
    TMP: temporary,
    CARGO_ENCODED_RUSTFLAGS: ['--remap-path-prefix', `${sourceRoot}=.`].join('\x1f'),
    ...extra,
  };
}

function inspectToolchain() {
  if (!existsSync(rustup))
    throw new Error('Pinned Rust is missing. Run the approved tooling/install-rust.ps1 bootstrap.');
  const stdout = capture(rustup, ['run', RUST.release, 'rustc', '--version', '--verbose'], {
    env: cargoEnv(root, BRANCH_TARGET),
  });
  const field = (name) =>
    stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2);
  if (
    field('release') !== RUST.release ||
    field('commit-hash') !== RUST.commit ||
    field('host') !== RUST.host
  )
    throw new Error(`Compiler identity differs from the approved toolchain: ${stdout}`);
  return { release: RUST.release, commit: RUST.commit, host: RUST.host };
}

function timed(durations, name, action) {
  const start = Date.now();
  const value = action();
  durations[name] = Date.now() - start;
  console.log(`P3 B0R identity: ${name} ${(durations[name] / 1000).toFixed(1)} s`);
  return value;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------------------------
// O5: no existing test changed outside the reviewed allow-list; inline test modules
// byte-identical.

function checkTestFiles(baseCommit, allowList) {
  const listing = git(
    'diff',
    '--name-status',
    baseCommit,
    '--',
    `${KERNEL_SRC}/*_tests.rs`,
    'tests/',
  );
  const lines = listing === '' ? [] : listing.split(/\r?\n/u);
  const { allowed, failures } = checkTestFileChanges(lines, allowList);
  const modified = git('diff', '--name-only', '--diff-filter=MR', baseCommit, '--', KERNEL_SRC)
    .split(/\r?\n/u)
    .filter((file) => file.endsWith('.rs'));
  for (const file of modified) {
    const baseSource = capture('git', ['show', `${baseCommit}:${file}`]);
    const branchSource = readFileSync(path.join(root, file), 'utf8');
    failures.push(...compareInlineTestModules(file, baseSource, branchSource));
  }
  return { listing: lines, allowList, allowed, modified, failures };
}

// ---------------------------------------------------------------------------------------------
// Merge-base tree with the bootstrap overlay.

function prepareBase(workspace, baseCommit) {
  const sourceRoot = path.join(workspace, 'source');
  mkdirSync(sourceRoot);
  run('git', ['archive', '--format=tar', '-o', path.join(workspace, 'base.tar'), baseCommit]);
  // A relative archive path keeps drive letters away from tar. `tests` holds the fixtures
  // that kernel tests include at compile time.
  run('tar', ['-xf', '../base.tar', KERNEL, 'tests'], { cwd: sourceRoot });
  const overlay = { harnessCopied: false, declarationInserted: false };
  const target = path.join(sourceRoot, HARNESS);
  const harness = readFileSync(path.join(root, HARNESS));
  if (!existsSync(target) || !readFileSync(target).equals(harness)) {
    copyFileSync(path.join(root, HARNESS), target);
    overlay.harnessCopied = true;
  }
  const libPath = path.join(sourceRoot, KERNEL_SRC, 'lib.rs');
  const lib = readFileSync(libPath, 'utf8');
  const declaration = `#[cfg(test)]\nmod ${HARNESS_MODULE};\n`;
  if (!lib.includes(declaration)) {
    const anchor = '#[cfg(test)]\nmod p3_b0_bench;\n';
    if (!lib.includes(anchor))
      throw new Error(
        'Bootstrap overlay: merge-base lib.rs has no p3_b0_bench declaration anchor.',
      );
    writeFileSync(libPath, lib.replace(anchor, `${anchor}${declaration}`));
    overlay.declarationInserted = true;
  }
  return { sourceRoot, overlay };
}

function buildTests(sourceRoot, targetDirectory) {
  run(
    rustup,
    [
      'run',
      RUST.release,
      'cargo',
      'test',
      '--manifest-path',
      path.join(sourceRoot, KERNEL, 'Cargo.toml'),
      '--release',
      '--lib',
      '--locked',
      '--offline',
      '--no-run',
    ],
    { env: cargoEnv(sourceRoot, targetDirectory) },
  );
}

function buildWasm(sourceRoot, targetDirectory) {
  run(
    rustup,
    [
      'run',
      RUST.release,
      'cargo',
      'build',
      '--manifest-path',
      path.join(sourceRoot, KERNEL, 'Cargo.toml'),
      '--locked',
      '--offline',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
    ],
    { env: cargoEnv(sourceRoot, targetDirectory) },
  );
  return path.join(targetDirectory, WASM_RELATIVE);
}

const ORACLE_FILTER = 'b0r_oracle_full';
/** Every full-size oracle that must run and pass; each B0R unit adds its own names. */
const EXPECTED_ORACLES = [
  'fill_filter_tests::b0r_oracle_full_o1_filter_module',
  'simple_cubic_topology_filter_tests::b0r_oracle_full_o1_topology',
  'fill_exact_tests::b0r_oracle_full_u1b_fill_exact',
  'simple_cubic_topology_sweep_tests::b0r_oracle_full_o3a_lemma_a',
  'simple_cubic_topology_sweep_tests::b0r_oracle_full_o3b_corpus_shadow',
  'simple_cubic_topology_sweep_tests::b0r_oracle_full_o3b_random_scenes',
  'fill_predicates_filter_tests::b0r_oracle_full_o1_binary64_predicates',
  'fill_event_order_filter_tests::b0r_oracle_full_o1_event_order',
  'fill_sections_filter_tests::b0r_oracle_full_o1_sections',
  'fill_sections_filter_tests::b0r_oracle_full_o10_tessellation_shadow',
  'fill_sections_slab_tests::b0r_oracle_full_o1_slab_sections',
  'fill_sections_slab_tests::b0r_oracle_full_slab_corpus_rates',
  'rounded_line_fill_loop_tests::b0r_oracle_full_o10_event_loops',
  'rounded_line_fill_loop_tests::b0r_oracle_full_o11_charge_lemmas',
  'rounded_line_fill_scan_tests::b0r_oracle_full_o10_scan_loops',
  'rounded_line_fill_scan_tests::b0r_oracle_full_o11_scan_loops',
];

/** Failures of one oracle run: exit status, the cargo summary, and every expected test run. */
function oracleFailures(status, stdout) {
  const failures = [];
  if (status !== 0) failures.push(`cargo exited with ${status}`);
  const summary = /test result: (\w+)\. (\d+) passed; (\d+) failed/u.exec(stdout);
  if (!summary) {
    failures.push('no cargo test summary line');
    return { failures, passed: 0, failed: null };
  }
  const passed = Number(summary[2]);
  const failed = Number(summary[3]);
  if (summary[1] !== 'ok' || failed !== 0) failures.push(`${failed} oracle tests failed`);
  if (passed < EXPECTED_ORACLES.length)
    failures.push(`${passed} oracle tests passed, expected at least ${EXPECTED_ORACLES.length}`);
  const started = new Set(
    stdout
      .split(/\r?\n/u)
      .map((line) => /^test (\S+) \.\.\./u.exec(line)?.[1])
      .filter(Boolean),
  );
  for (const name of EXPECTED_ORACLES)
    if (!started.has(name)) failures.push(`expected oracle ${name} did not run`);
  return { failures, passed, failed };
}

/** Runs every full-size oracle; the O3(b) corpus oracle reads the O4 corpora (unit U2). */
function runOracles(file, corpora) {
  const args = [
    'run',
    RUST.release,
    'cargo',
    'test',
    '--manifest-path',
    path.join(root, KERNEL, 'Cargo.toml'),
    '--release',
    '--lib',
    '--locked',
    '--offline',
    ORACLE_FILTER,
    '--',
    '--ignored',
    '--nocapture',
    '--test-threads',
    '1',
  ];
  console.log(`> ${path.basename(rustup)} ${args.join(' ')}`);
  const result = spawnSync(rustup, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: cargoEnv(root, BRANCH_TARGET, {
      P3_B0R_B0_CORPUS: corpora.b0,
      P3_B0R_RANDOM_CORPUS: corpora.random,
    }),
  });
  if (result.error) throw result.error;
  writeFileSync(file, `${result.stdout}${result.stderr}`);
  process.stdout.write(result.stdout);
  const { failures, passed, failed } = oracleFailures(result.status, result.stdout);
  return {
    status: result.status,
    passed,
    failed,
    expected: EXPECTED_ORACLES,
    failures,
    file: path.relative(root, file),
  };
}

function dumpNative(sourceRoot, targetDirectory, corpora, output, threads) {
  const extra = {
    P3_B0R_B0_CORPUS: corpora.b0,
    P3_B0R_RANDOM_CORPUS: corpora.random,
    P3_FILL_LADDER_CORPUS: corpora.ladder,
    P3_B0R_OUTPUT: output,
  };
  if (threads) extra.P3_B0R_THREADS = String(threads);
  run(
    rustup,
    [
      'run',
      RUST.release,
      'cargo',
      'test',
      '--manifest-path',
      path.join(sourceRoot, KERNEL, 'Cargo.toml'),
      '--release',
      '--lib',
      '--locked',
      '--offline',
      HARNESS_TEST,
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    { env: cargoEnv(sourceRoot, targetDirectory, extra) },
  );
  return parseNativeDigests(readFileSync(output, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// WASM layer.

/** A release fill-v0 kernel; the revision is checked between the trees (section 4.4). */
async function loadFillKernel(file) {
  const { instance } = await WebAssembly.instantiate(readFileSync(file), {});
  const kernel = instance.exports;
  const revision = kernel.fill_v0_revision();
  if (kernel.fill_v0_version() !== 0 || !Number.isInteger(revision) || revision < 1)
    throw new Error(`${file}: unexpected fill-v0 version or revision`);
  if (kernel.fill_v0_reserve(WASM_INPUT_BYTES, WASM_OUTPUT_BYTES) !== BATCH_OK)
    throw new Error(`${file}: fill_v0_reserve failed`);
  return { kernel, revision };
}

function runFillPath(kernel, input) {
  new Uint8Array(kernel.memory.buffer, kernel.fill_v0_input_ptr() >>> 0, input.length).set(input);
  const status = kernel.fill_v0_process(input.length);
  const length = kernel.fill_v0_result_len() >>> 0;
  const required = kernel.fill_v0_required_output_bytes() >>> 0;
  const output = new Uint8Array(kernel.memory.buffer, kernel.fill_v0_output_ptr() >>> 0, length);
  const hash = createHash('sha256');
  // Same text as the native harness's cascade digest, so WASM and native compare directly.
  hash.update(
    `entry=fill_v0_cascade\nstatus=${status}\nresult_len=${length}\nrequired_output_bytes=${required}\n`,
  );
  hash.update(output);
  const code =
    status === BATCH_OK
      ? `path_status=${new DataView(output.buffer, output.byteOffset + 68, 4).getUint32(0, true)}`
      : `batch_status=${status}`;
  return { digest: hash.digest('hex'), allocations: 0, code, crossings: 0 };
}

/**
 * The WASM case list: B0 decision cells (every path), the selected randomized paths and every
 * `p3-fill-ladder-random/v1` path.
 */
function wasmCases(b0, selection, ladderPaths) {
  const cases = [];
  for (const cell of b0.corpusCells().filter((item) => item.role === 'decision')) {
    b0.generateCellPaths(cell).forEach((item, index) =>
      cases.push({
        name: `wasm/b0/${cell.id}/${String(index).padStart(4, '0')}`,
        input: packFillInput(item.verbs, item.points, 0, B0_EXPONENT, index),
      }),
    );
  }
  for (const { family, index, path: item } of selection)
    cases.push({
      name: `wasm/rnd/${family}/${String(index).padStart(4, '0')}`,
      input: packFillInput(item.verbs, item.points, item.rule, item.exponent, index),
    });
  ladderPaths.forEach((item, index) =>
    cases.push({
      name: `wasm/rnd/${LADDER_FAMILY_ID}/${String(index).padStart(4, '0')}`,
      input: packFillInput(item.verbs, item.points, item.rule, item.exponent, index),
    }),
  );
  return cases;
}

async function wasmLayer(baseWasm, branchWasm, cases) {
  const loaded = [await loadFillKernel(baseWasm), await loadFillKernel(branchWasm)];
  const maps = [new Map(), new Map()];
  for (const { name, input } of cases)
    loaded.forEach(({ kernel }, side) => maps[side].set(name, runFillPath(kernel, input)));
  return {
    base: maps[0],
    branch: maps[1],
    revisions: { base: loaded[0].revision, branch: loaded[1].revision },
  };
}

function writeDigests(file, cases) {
  const lines = [...cases].map(
    ([name, entry]) =>
      `${name}\t${entry.digest}\t${entry.allocations}\t${entry.code}\t${entry.crossings}`,
  );
  writeFileSync(file, `${lines.join('\n')}\n`, { flag: 'wx' });
}

function report(label, comparison) {
  if (comparison.equal) {
    console.log(`P3 B0R identity: ${label}: all digests equal`);
    return;
  }
  console.error(
    `P3 B0R identity: ${label}: MISMATCH (${comparison.differing.length} differing, ${comparison.missing.length} missing, ${comparison.extra.length} extra)`,
  );
  for (const name of [...comparison.differing, ...comparison.missing, ...comparison.extra].slice(
    0,
    25,
  ))
    console.error(`  ${name}`);
}

function tamperSelfCheck(base, branch, name) {
  const comparison = compareDigests(base, tamper(branch, name));
  const detected =
    !comparison.equal &&
    comparison.differing.length === 1 &&
    comparison.differing[0] === name &&
    comparison.missing.length === 0 &&
    comparison.extra.length === 0;
  return { case: name, detected, differing: comparison.differing };
}

// ---------------------------------------------------------------------------------------------
// Alt-A1 AL-U2: the ladder corpus, the rung record and the oracle validation.

// The ladder modules import each other with `.js` specifiers, as the type checker requires;
// Node's type stripping loads the `.ts` file only when the `.js` one is absent (as the spike
// runner resolves them). Installed only when a full run or the oracle validation needs them.
let resolverInstalled = false;
function importTypeScript(relative) {
  if (!resolverInstalled) {
    resolverInstalled = true;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
            const candidate = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL);
            if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
          }
          throw error;
        }
      },
    });
  }
  return import(pathToFileURL(path.join(root, relative)).href);
}

function cargoTestBranch(test, extra) {
  run(
    rustup,
    [
      'run',
      RUST.release,
      'cargo',
      'test',
      '--manifest-path',
      path.join(root, KERNEL, 'Cargo.toml'),
      '--release',
      '--lib',
      '--locked',
      '--offline',
      test,
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    { env: cargoEnv(root, BRANCH_TARGET, extra) },
  );
}

/** The branch's rung record (section 4.4), over the identity harness's corpora and names. */
function dumpRungs(corpora, output, threads) {
  const extra = {
    P3_B0R_B0_CORPUS: corpora.b0,
    P3_B0R_RANDOM_CORPUS: corpora.random,
    P3_FILL_LADDER_CORPUS: corpora.ladder,
    P3_FILL_LADDER_RUNGS: output,
  };
  if (threads) extra.P3_B0R_THREADS = String(threads);
  cargoTestBranch(RUNG_TEST, extra);
  return parseRungRecord(readFileSync(output, 'utf8'));
}

/** Every identity path by its rung-record name, with its request and source. */
export function pathSources(b0, random, ladderPaths) {
  const sources = new Map();
  const index4 = (index) => String(index).padStart(4, '0');
  for (const cell of b0.corpusCells())
    b0.generateCellPaths(cell).forEach((item, index) =>
      sources.set(`b0/${cell.id}/${index4(index)}`, {
        rule: 0,
        exponent: B0_EXPONENT,
        ...item,
      }),
    );
  for (const { family, paths } of random.generateRandomCorpus())
    paths.forEach((item, index) => sources.set(`rnd/${family.id}/${index4(index)}`, item));
  ladderPaths.forEach((item, index) =>
    sources.set(`rnd/${LADDER_FAMILY_ID}/${index4(index)}`, item),
  );
  return sources;
}

/**
 * SL-O1 and SL-O2 on every changed path: the `emit_fill_ladder_dump` hand-off on the branch,
 * judged by `tests/geometry/p3-fill-ladder/oracle.ts`. Writes the input, the dump and
 * `oracle-validation.json` into the run directory and returns path to { rung, failures }. The
 * dump must come from a kernel of the branch's `revision`.
 */
export async function validateChangedPaths(paths, sources, directory, revision) {
  const validation = new Map();
  const file = path.join(directory, 'oracle-validation.json');
  if (paths.length === 0) {
    writeFileSync(file, `${JSON.stringify({ entries: {} }, null, 2)}\n`, { flag: 'wx' });
    return validation;
  }
  const corpus = await importTypeScript('tests/geometry/p3-fill-ladder/corpus.ts');
  const { parseLadderDump } = await importTypeScript('tests/geometry/p3-fill-ladder/dump.ts');
  const oracle = await importTypeScript('tests/geometry/p3-fill-ladder/oracle.ts');
  const inputs = paths.map((name) => {
    const source = sources.get(name);
    if (source === undefined) throw new Error(`No corpus path ${name}`);
    return {
      name,
      kind: 'path',
      rule: source.rule,
      exponent: source.exponent,
      verbs: source.verbs,
      points: source.points,
    };
  });
  const input = path.join(directory, 'ladder-dump-input.bin');
  const output = path.join(directory, 'ladder-dump.txt');
  writeFileSync(input, corpus.encodeDumpInput(inputs), { flag: 'wx' });
  cargoTestBranch(DUMP_TEST, { P3_FILL_LADDER_INPUT: input, P3_FILL_LADDER_DUMP: output });
  const text = readFileSync(output, 'utf8');
  const dump = parseLadderDump(text);
  if (dump.revision !== revision)
    throw new Error(
      `The ladder dump reports revision ${dump.revision}, the branch kernel ${revision}`,
    );
  const entries = {};
  for (const entry of dump.entries) {
    const failures = oracle.evaluationFailures(oracle.evaluateEntry(entry, dump.revision));
    validation.set(entry.name, { rung: entry.rung, failures });
    entries[entry.name] = { rung: entry.rung, reason: entry.reason, failures };
  }
  writeFileSync(
    file,
    `${JSON.stringify({ revision: dump.revision, dumpSha256: sha256(text), entries }, null, 2)}\n`,
    { flag: 'wx' },
  );
  return validation;
}

function loadValidation(file) {
  const { entries } = JSON.parse(readFileSync(file, 'utf8'));
  return new Map(Object.entries(entries));
}

/** Section 4.4's revision-change verdict over finished digests, rung record and validation. */
function revisionChangeResult(input, validation) {
  const classification = classifyRevisionChange(input);
  const failures = [
    ...classification.failures,
    ...applyOracleValidation(classification.cases, validation),
  ];
  const manifest = revisionManifest(classification.cases);
  const unchanged =
    classification.cases.find((item) => item.class === 'unchanged' && item.layer === 'native') ??
    classification.cases.find((item) => item.class === 'unchanged');
  const selfCheck = unchanged
    ? revisionSelfCheck(input, unchanged.case)
    : { case: null, detected: false };
  if (!selfCheck.detected)
    failures.push('revision-change self-check: a seeded unexpected change was not detected');
  return { classification, manifest, failures, selfCheck };
}

function reportRevisionChange(result) {
  console.log(
    `P3 B0R identity: revision-change manifest ${result.classification.cases.length} cases, SHA-256 ${result.manifest.sha256}`,
  );
  for (const [key, counts] of Object.entries(result.manifest.counts))
    console.log(`  ${key}: ${JSON.stringify(counts)}`);
  if (result.classification.metaDiffering.length > 0)
    console.log(
      `P3 B0R identity: meta cases differing (recorded): ${result.classification.metaDiffering.join(', ')}`,
    );
  console.log(
    `P3 B0R identity: revision-change self-check ${result.selfCheck.case}: ${result.selfCheck.detected ? 'detected' : 'NOT DETECTED'}`,
  );
  for (const failure of result.failures.slice(0, 25))
    console.error(`P3 B0R identity: revision-change FAIL ${failure}`);
}

// ---------------------------------------------------------------------------------------------
// Modes.

function compareOnly(directory, tamperCase, revisionChange) {
  const load = (name) => parseNativeDigests(readFileSync(path.join(directory, name), 'utf8'));
  const native = { base: load('native-base.tsv'), branch: load('native-branch.tsv') };
  const wasm = { base: load('wasm-base.tsv'), branch: load('wasm-branch.tsv') };
  if (tamperCase !== null) {
    if (native.branch.has(tamperCase)) native.branch = tamper(native.branch, tamperCase);
    else wasm.branch = tamper(wasm.branch, tamperCase);
    console.log(`P3 B0R identity: tampered branch digest of ${tamperCase}`);
  }
  const cross = compareWasmToNative(wasm.branch, native.branch);
  report('wasm-vs-native', cross);
  console.log(
    `P3 B0R identity (compare-only${revisionChange ? ', revision-change' : ''}): ${native.base.size} native and ${wasm.base.size} WASM cases`,
  );
  // The revision rule of section 4.4, from the revisions the full run stored.
  const revisionsFile = path.join(directory, 'revisions.json');
  const revisionFailures = existsSync(revisionsFile)
    ? (({ base, branch }) => checkRevisions(base, branch, revisionChange))(
        JSON.parse(readFileSync(revisionsFile, 'utf8')),
      )
    : revisionChange
      ? ['revisions.json is missing from the run directory']
      : [];
  for (const failure of revisionFailures) console.error(`P3 B0R identity: FAIL ${failure}`);
  if (revisionChange) {
    const rungs = parseRungRecord(readFileSync(path.join(directory, 'rungs-branch.tsv'), 'utf8'));
    const validation = loadValidation(path.join(directory, 'oracle-validation.json'));
    const result = revisionChangeResult({ native, wasm, rungs }, validation);
    reportRevisionChange(result);
    return cross.equal && revisionFailures.length === 0 && result.failures.length === 0;
  }
  const results = [
    ['native', compareDigests(native.base, native.branch)],
    ['wasm', compareDigests(wasm.base, wasm.branch)],
  ];
  for (const [label, comparison] of results) report(label, comparison);
  return (
    cross.equal &&
    revisionFailures.length === 0 &&
    results.every(([, comparison]) => comparison.equal)
  );
}

/**
 * The `--revision-change` self-test (section 4.4) on a synthetic run directory, one case of
 * each class: the clean directory passes in revision-change mode, the same directory with a
 * seeded unexpected change (a rung-1 case's branch digest tampered) fails, so does a branch
 * revision that is not base + 1, and plain mode refuses the changed cases.
 */
function selfTest() {
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(path.join(temporary, 'p3-fill-identity-self-test-'));
  try {
    const digestOf = (fill) => fill.repeat(64);
    const line = (name, fill, code) => `${name}\t${digestOf(fill)}\t0\t${code}\t0`;
    const cascade = (index) => `rnd/T/${index}/fill_v0_cascade`;
    const base = [
      ['0000', 'c', 'path_status=0'],
      ['0001', 'd', 'path_status=0'],
      ['0002', 'e', 'path_status=0'],
      ['0003', '1', 'path_status=6'],
    ];
    const branch = [
      ['0000', 'c', 'path_status=0'],
      ['0001', 'd', 'path_status=0'],
      ['0002', 'f', 'path_status=0'],
      ['0003', '2', 'path_status=0'],
    ];
    const native = (rows) =>
      [
        line('meta/cubic-workspace-sizes', 'a', 'META'),
        line(FILL_ENGINE_META, 'a', 'META'),
        line('rnd/T/0000/attempt', 'b', 'OK'),
        ...rows.map(([index, fill, code]) => line(cascade(index), fill, code)),
        '',
      ].join('\n');
    const wasm = (rows) =>
      [...rows.map(([index, fill, code]) => line(`wasm/rnd/T/${index}`, fill, code)), ''].join(
        '\n',
      );
    const write = (name, text) => writeFileSync(path.join(directory, name), text);
    write('native-base.tsv', native(base));
    write('native-branch.tsv', native(branch));
    write('wasm-base.tsv', wasm(base));
    write('wasm-branch.tsv', wasm(branch));
    write(
      'rungs-branch.tsv',
      [
        'rnd/T/0000\t1\tCROSSING\tLegacy\tOk(flat_status=0)',
        'rnd/T/0001\t0\t-\t-\t-',
        'rnd/T/0002\t0\t-\t-\t-',
        'rnd/T/0003\t0\t-\t-\t-',
        '',
      ].join('\n'),
    );
    const fast = { rung: 'fast', reason: null, failures: [] };
    write(
      'oracle-validation.json',
      JSON.stringify({ entries: { 'rnd/T/0001': fast, 'rnd/T/0002': fast, 'rnd/T/0003': fast } }),
    );
    write('revisions.json', JSON.stringify({ base: 1, branch: 2 }));
    const clean = compareOnly(directory, null, true);
    const seeded = compareOnly(directory, cascade('0000'), true);
    write('revisions.json', JSON.stringify({ base: 1, branch: 1 }));
    const unrevised = compareOnly(directory, null, true);
    const plain = compareOnly(directory, null, false);
    const pass = clean && !seeded && !unrevised && !plain;
    console.log(
      `P3 B0R identity self-test: clean revision-change ${clean ? 'PASS' : 'FAIL'}; seeded unexpected change ${seeded ? 'NOT DETECTED' : 'detected'}; revision not base + 1 ${unrevised ? 'NOT DETECTED' : 'detected'}; plain mode on changed cases ${plain ? 'NOT DETECTED' : 'detected'}; ${pass ? 'PASS' : 'FAIL'}`,
    );
    return pass;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function fullRun(options) {
  const started = new Date();
  const durations = {};
  const toolchain = inspectToolchain();
  mkdirSync(temporary, { recursive: true });
  const base = options.base ?? git('merge-base', 'HEAD', 'main');
  const baseCommit = git('rev-parse', '--verify', `${base}^{commit}`);
  const headCommit = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain');

  const runId = `${started
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '')}-${randomBytes(4).toString('hex')}`;
  const output = path.join(root, 'artifacts/p3-b0r-identity', runId);
  mkdirSync(output, { recursive: true });
  console.log(
    `P3 B0R identity: base ${baseCommit}, head ${headCommit}, mode ${options.revisionChange ? 'revision-change' : 'plain'}, output ${path.relative(root, output)}`,
  );

  const b0 = await import(pathToFileURL(path.join(root, 'tests/geometry/p3-b0/corpus.ts')).href);
  const random = await import(
    pathToFileURL(path.join(root, 'tests/geometry/p3-b0r/corpus.ts')).href
  );
  const ladder = await importTypeScript('tests/geometry/p3-fill-ladder/corpus.ts');
  const corpora = {
    b0: path.join(output, 'b0-corpus.bin'),
    random: path.join(output, 'random-corpus.bin'),
    ladder: path.join(output, 'ladder-corpus.bin'),
  };
  const ladderPaths = ladder.generateLadderCorpus();
  const b0Bytes = b0.encodeCorpus(b0.corpusCells());
  const randomBytes_ = random.encodeRandomCorpus();
  const ladderBytes = ladder.encodeLadderCorpus(ladderPaths);
  writeFileSync(corpora.b0, b0Bytes, { flag: 'wx' });
  writeFileSync(corpora.random, randomBytes_, { flag: 'wx' });
  writeFileSync(corpora.ladder, ladderBytes, { flag: 'wx' });
  const corpusSha = {
    b0: sha256(b0Bytes),
    random: sha256(randomBytes_),
    ladder: sha256(ladderBytes),
  };
  if (corpusSha.b0 !== B0_CORPUS_SHA256)
    throw new Error(
      `B0 corpus SHA-256 ${corpusSha.b0} differs from the frozen ${B0_CORPUS_SHA256}`,
    );
  if (corpusSha.random !== RANDOM_CORPUS_SHA256)
    throw new Error(
      `Randomized corpus SHA-256 ${corpusSha.random} differs from the pinned ${RANDOM_CORPUS_SHA256}`,
    );
  if (corpusSha.ladder !== LADDER_CORPUS_SHA256)
    throw new Error(
      `Ladder corpus SHA-256 ${corpusSha.ladder} differs from the pinned ${LADDER_CORPUS_SHA256}`,
    );
  console.log(
    `P3 B0R identity: corpus SHA-256 B0 ${corpusSha.b0}, ${random.RANDOM_CORPUS_ID} ${corpusSha.random}, ${ladder.LADDER_CORPUS_ID} ${corpusSha.ladder}`,
  );

  const testFiles = checkTestFiles(baseCommit, options.allowTestChanges);
  writeFileSync(
    path.join(output, 'allowed-test-changes.json'),
    `${JSON.stringify({ allowList: testFiles.allowList, allowed: testFiles.allowed, listing: testFiles.listing }, null, 2)}\n`,
    { flag: 'wx' },
  );
  const failures = [...testFiles.failures];
  console.log(
    `P3 B0R identity: O5 modified kernel sources ${testFiles.modified.length === 0 ? 'none' : testFiles.modified.join(', ')}; test-file changes ${testFiles.listing.length === 0 ? 'none' : testFiles.listing.join(', ')}; allow-list ${testFiles.allowList.length === 0 ? 'empty' : testFiles.allowList.join(', ')}; allowed ${testFiles.allowed.length === 0 ? 'none' : testFiles.allowed.join(', ')}`,
  );

  const workspace = mkdtempSync(path.join(cache, 'p3-fill-identity-'));
  let summary;
  try {
    const { sourceRoot, overlay } = prepareBase(workspace, baseCommit);
    console.log(`P3 B0R identity: bootstrap overlay ${JSON.stringify(overlay)}`);
    const baseTarget = path.join(workspace, 'target');
    timed(durations, 'buildBaseTestsMs', () => buildTests(sourceRoot, baseTarget));
    timed(durations, 'buildBranchTestsMs', () => buildTests(root, BRANCH_TARGET));
    const baseWasm = timed(durations, 'buildBaseWasmMs', () => buildWasm(sourceRoot, baseTarget));
    const branchWasm = timed(durations, 'buildBranchWasmMs', () => buildWasm(root, BRANCH_TARGET));
    const wasmSha = {
      base: sha256(readFileSync(baseWasm)),
      branch: sha256(readFileSync(branchWasm)),
    };
    console.log(
      `P3 B0R identity: release WASM SHA-256 base ${wasmSha.base}, branch ${wasmSha.branch}`,
    );

    const native = {
      base: timed(durations, 'nativeBaseMs', () =>
        dumpNative(
          sourceRoot,
          baseTarget,
          corpora,
          path.join(output, 'native-base.tsv'),
          options.threads,
        ),
      ),
      branch: timed(durations, 'nativeBranchMs', () =>
        dumpNative(
          root,
          BRANCH_TARGET,
          corpora,
          path.join(output, 'native-branch.tsv'),
          options.threads,
        ),
      ),
    };
    const oracles = timed(durations, 'oraclesBranchMs', () =>
      runOracles(path.join(output, 'oracles-branch.txt'), corpora),
    );
    for (const failure of oracles.failures)
      failures.push(`release oracles: ${failure} (${oracles.file})`);
    const crossingPaths = new Set();
    for (const [name, entry] of native.branch) {
      const match = /^rnd\/([^/]+)\/(\d+)\//u.exec(name);
      if (match && entry.crossings > 0 && (entry.code === 'OK' || entry.code === 'path_status=0'))
        crossingPaths.add(`${match[1]}/${Number(match[2])}`);
    }
    const selection = selectWasmRandomPaths(random.generateRandomCorpus(), crossingPaths);
    const cases = wasmCases(b0, selection, ladderPaths);
    const wasmStart = Date.now();
    const wasm = await wasmLayer(baseWasm, branchWasm, cases);
    durations.wasmLayerMs = Date.now() - wasmStart;
    writeDigests(path.join(output, 'wasm-base.tsv'), wasm.base);
    writeDigests(path.join(output, 'wasm-branch.tsv'), wasm.branch);
    console.log(
      `P3 B0R identity: fill_v0_revision() base ${wasm.revisions.base}, branch ${wasm.revisions.branch}`,
    );
    failures.push(
      ...checkRevisions(wasm.revisions.base, wasm.revisions.branch, options.revisionChange),
    );
    writeFileSync(
      path.join(output, 'revisions.json'),
      `${JSON.stringify(wasm.revisions)}
`,
      {
        flag: 'wx',
      },
    );

    const nativeComparison = compareDigests(native.base, native.branch);
    const wasmComparison = compareDigests(wasm.base, wasm.branch);
    const crossComparison = compareWasmToNative(wasm.branch, native.branch);
    report('wasm-vs-native', crossComparison);
    if (!crossComparison.equal) failures.push('WASM cascade digests differ from native ones');
    let revision = null;
    if (options.revisionChange) {
      const rungs = timed(durations, 'rungRecordMs', () =>
        dumpRungs(corpora, path.join(output, 'rungs-branch.tsv'), options.threads),
      );
      const input = {
        native: { base: native.base, branch: native.branch },
        wasm: { base: wasm.base, branch: wasm.branch },
        rungs,
      };
      const changed = changedPaths(classifyRevisionChange(input).cases);
      const validationStart = Date.now();
      const validation = await validateChangedPaths(
        changed,
        pathSources(b0, random, ladderPaths),
        output,
        wasm.revisions.branch,
      );
      durations.oracleValidationMs = Date.now() - validationStart;
      const result = revisionChangeResult(input, validation);
      writeFileSync(path.join(output, 'revision-change-manifest.tsv'), result.manifest.text, {
        flag: 'wx',
      });
      reportRevisionChange(result);
      failures.push(...result.failures.map((failure) => `revision change: ${failure}`));
      revision = {
        manifestSha256: result.manifest.sha256,
        manifestFile: 'revision-change-manifest.tsv',
        counts: result.manifest.counts,
        validatedPaths: changed.length,
        metaDiffering: result.classification.metaDiffering,
        selfCheck: result.selfCheck,
        failures: result.failures,
      };
    } else {
      report('native', nativeComparison);
      report('wasm', wasmComparison);
      if (!nativeComparison.equal) failures.push('native digests differ');
      if (!wasmComparison.equal) failures.push('WASM digests differ');
    }

    // WASM coverage: status codes, crossing cases (from the native cascade) and exponents.
    const tally = (items) =>
      items.reduce((counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }), {});
    const wasmCoverage = {
      statusCodes: tally([...wasm.branch.values()].map((entry) => entry.code)),
      crossingCases: [...wasm.branch.keys()].filter(
        (name) => (native.branch.get(nativeCascadeName(name))?.crossings ?? 0) > 0,
      ).length,
      randomByFamily: tally(selection.map((item) => item.family)),
      randomByReason: tally(selection.map((item) => item.reason)),
      randomExponents: tally(selection.map((item) => String(item.path.exponent))),
      ladderPaths: ladderPaths.length,
    };

    const allocating = ['base', 'branch'].flatMap((side) =>
      [...native[side]]
        .filter(([, entry]) => entry.allocations !== 0)
        .map(([name]) => `${side}:${name}`),
    );
    if (allocating.length > 0)
      failures.push(
        `O7: ${allocating.length} entry calls allocated (${allocating.slice(0, 5).join(', ')})`,
      );

    const coverage = randomCoverage(native.branch);
    const missed = missedFloors(coverage.counts, random.COVERAGE_FLOORS);
    for (const item of missed) failures.push(`coverage floor missed: ${item}`);

    const nativeTamperCase = [...native.branch.keys()].find((name) => name.startsWith('rnd/'));
    const wasmTamperCase = [...wasm.branch.keys()][0];
    const tamperChecks = [
      tamperSelfCheck(native.base, native.branch, nativeTamperCase),
      tamperSelfCheck(wasm.base, wasm.branch, wasmTamperCase),
    ];
    for (const check of tamperChecks)
      if (!check.detected) failures.push(`tamper self-check not detected for ${check.case}`);

    const count = (map, prefix) => [...map.keys()].filter((name) => name.startsWith(prefix)).length;
    summary = {
      tool: 'compare-p3-fill-identity/2',
      contract: 'docs/plans/p3-b0r-kernel-performance-contract.md',
      amendedBy: 'docs/plans/p3-alt-a1-fill-ladder-contract.md',
      mode: options.revisionChange ? 'revision-change' : 'plain',
      runId,
      utcStart: started.toISOString(),
      utcEnd: new Date().toISOString(),
      baseCommit,
      headCommit,
      dirty: status !== '',
      dirtyFiles: status === '' ? [] : status.split(/\r?\n/u),
      environment: {
        os: `${os.type()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? null,
        logicalCores: os.cpus().length,
        node: process.versions.node,
        toolchain,
        threads: options.threads ?? 'available_parallelism',
      },
      overlay,
      corpusSha256: corpusSha,
      wasmSha256: { ...wasmSha, equal: wasmSha.base === wasmSha.branch },
      revisions: wasm.revisions,
      o5: testFiles,
      oracles,
      native: {
        cases: native.branch.size,
        b0Cases: count(native.branch, 'b0/'),
        randomCases: count(native.branch, 'rnd/'),
        ladderCases: count(native.branch, `rnd/${LADDER_FAMILY_ID}/`),
        comparison: nativeComparison,
        allocatingCases: allocating.length,
      },
      wasm: {
        cases: wasm.branch.size,
        b0Cases: count(wasm.branch, 'wasm/b0/'),
        randomCases: count(wasm.branch, 'wasm/rnd/'),
        ladderCases: count(wasm.branch, `wasm/rnd/${LADDER_FAMILY_ID}/`),
        comparison: wasmComparison,
        nativeCascadeComparison: crossComparison,
        coverage: wasmCoverage,
      },
      revisionChange: revision,
      coverage: { ...coverage, floors: random.COVERAGE_FLOORS, missed },
      tamperChecks,
      durationsMs: durations,
      failures,
      pass: failures.length === 0,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(
    `P3 B0R identity: native ${summary.native.cases} cases (${summary.native.b0Cases} B0, ${summary.native.randomCases} randomized, of which ${summary.native.ladderCases} ladder), WASM ${summary.wasm.cases} cases (${summary.wasm.ladderCases} ladder); coverage ${JSON.stringify(summary.coverage.counts)}`,
  );
  console.log(`P3 B0R identity: WASM coverage ${JSON.stringify(summary.wasm.coverage)}`);
  console.log(`P3 B0R identity: durations ${JSON.stringify(durations)}`);
  for (const check of summary.tamperChecks)
    console.log(
      `P3 B0R identity: tamper self-check ${check.case}: ${check.detected ? 'detected' : 'NOT DETECTED'}`,
    );
  for (const failure of failures) console.error(`P3 B0R identity: FAIL ${failure}`);
  console.log(`P3 B0R identity: ${summary.pass ? 'PASS' : 'FAIL'}; ${path.relative(root, output)}`);
  return summary.pass;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.selfTest) return selfTest();
  return options.compareOnly !== null
    ? compareOnly(path.resolve(options.compareOnly), options.tamper, options.revisionChange)
    : fullRun(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (pass) => {
      if (!pass) process.exitCode = 1;
    },
    (error) => {
      console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
      process.exitCode = 1;
    },
  );
}
