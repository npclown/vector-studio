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
// `--failure-to-success` (E8-U0, docs/plans/p3-rounded-knot-topology-contract.md section E8.2a)
// replaces step 6's digest equality by a per-record classification of the merge base against the
// branch, over the whole record tuple (digest, allocations, code, crossings). identical: the base
// record is not a path failure and every field is equal (or a path failure that is unchanged).
// allowed change: the base is a path failure and the branch is `ok` or another path failure.
// FAIL: the base is not a path failure and any field differs, or a record is missing or extra.
// internal-regression (also FAIL, reported separately): a base path failure becomes an internal
// error, a batch failure or an unrecognized code. The run passes only with no FAIL. Every other
// step (O5, O7, coverage floors, oracles, revisions) is unchanged. Excludes `--revision-change`.
//
// Re-comparison of a finished run, with an optional tampered digest:
//   node tooling/compare-p3-fill-identity.mjs --compare-only <run-dir> [--tamper <case>]
//     [--revision-change | --failure-to-success]
// Self-test of the revision-change and failure-to-success modes on synthetic data (no kernel
// needed):
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
const cargoHome = process.env.CARGO_HOME || path.join(cache, 'rust/cargo');
const rustupHome = process.env.RUSTUP_HOME || path.join(cache, 'rust/rustup');
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
  // `failureToSuccess` is set only by its flag, so the option record of every other invocation
  // keeps the shape that the reviewed AL-U2 test of `parseArguments` pins (O5: that file stays).
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === '--revision-change' || flag === '--failure-to-success' || flag === '--self-test') {
      if (flag === '--revision-change') options.revisionChange = true;
      else if (flag === '--failure-to-success') options.failureToSuccess = true;
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
  if (options.revisionChange && options.failureToSuccess)
    throw new Error('--revision-change and --failure-to-success exclude each other.');
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

/**
 * The full run's tamper self-check in revision-change mode (AL-U3). Plain mode's check needs
 * exactly one differing case, which cannot hold when a revision change legitimately changes
 * thousands of cases. Here one native entry case (an AL-I1 case) and one WASM case of the
 * `unchanged` class are tampered, each on its own, and the classification must then report
 * that case by name: an AL-I1 entry difference, or a rung-1 case whose bytes differ.
 */
export function revisionTamperChecks(input) {
  const nativeCase = [...input.native.branch.keys()].find(
    (name) => rungPathOf(name) === null && !name.startsWith('meta/') && input.native.base.has(name),
  );
  const wasmCase = classifyRevisionChange(input).cases.find(
    (item) => item.layer === 'wasm' && item.class === 'unchanged',
  )?.case;
  return [nativeCase, wasmCase].map((name) => {
    if (name === undefined) return { case: null, detected: false };
    const layer = name.startsWith('wasm/') ? 'wasm' : 'native';
    const tampered = {
      ...input,
      [layer]: { ...input[layer], branch: tamper(input[layer].branch, name) },
    };
    const expected = [
      `AL-I1: entry case ${name} differs from the merge base`,
      `${name}: rung 1 but the bytes differ`,
    ];
    const { failures } = classifyRevisionChange(tampered);
    return {
      case: name,
      detected: failures.some((failure) => expected.some((start) => failure.startsWith(start))),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// E8-U0 pure helpers (E8.2a): the `--failure-to-success` classification.

/**
 * Error codes (the Debug text of `CubicFillError`) that `fill_export::map_attempt_error` maps to
 * a path status, and the ones it maps to an internal error. The two lists follow that function.
 */
const PATH_FAILURE_ERROR =
  /^(SourceLimit|CommandLimit|ContourLimit|PointLimit|OwnerLimit|UnsupportedSource|ZeroLengthLeaf|Topology\((KnotMismatch|Unresolved|WorkLimit|ByteLimit)\)|Rounded\((InputLimit|EdgeLimit|PairLimit|EventLimit|SectionLimit|NodeLimit|CellLimit|BoundaryLimit|ContributorLimit|WorkLimit|OutputLimit|TopologyAmbiguous|InvalidTolerance)\))$/u;
const INTERNAL_ERROR =
  /^(EmissionStatus\(\d+\)|PlanMismatch|BoundsMismatch|InvalidCommand|InvalidProvenance|TopologyOwnership|RoundedOwnership|CombinedByteLimit|Topology\((InvalidInput|InvalidProvenance|InvalidLimits|AllocationFailed)\)|Rounded\((InvalidInput|InternalInvariant|InvalidLimits|AllocationFailed|ByteLimit)\))$/u;

/**
 * Class of an outcome code: `ok`, `empty` (a result, not a failure: `path_status=1` or
 * `NO_MESH(flat_status=1)`, which must stay equal and may be a target of a path failure), `path-failure`, `internal` (a kernel internal error), `batch`
 * (a non-zero fill-v0 batch status) or `other` (META, an empty mesh, anything unrecognized).
 * A path failure is a non-`ok`, non-`empty` path status: `path_status=2..6`, `NO_MESH(flat_status=2..5)` or a
 * kernel error that the fill-v0 port maps to a path status.
 */
export function classifyOutcome(code) {
  if (code === 'OK' || code === 'path_status=0') return 'ok';
  let match = /^path_status=(\d+)$/u.exec(code);
  if (match) {
    const status = Number(match[1]);
    if (status === 1) return 'empty';
    return status >= 2 && status <= 6 ? 'path-failure' : 'other';
  }
  match = /^NO_MESH\(flat_status=(\d+)\)$/u.exec(code);
  if (match) {
    const status = Number(match[1]);
    if (status === 1) return 'empty';
    return status >= 2 && status <= 5 ? 'path-failure' : 'internal';
  }
  match = /^batch_status=(\d+)$/u.exec(code);
  if (match) return Number(match[1]) !== 0 ? 'batch' : 'other';
  if (PATH_FAILURE_ERROR.test(code)) return 'path-failure';
  if (INTERNAL_ERROR.test(code)) return 'internal';
  return 'other';
}

const RECORD_FIELDS = ['digest', 'allocations', 'code', 'crossings'];

/** The fields in which two records differ, over the whole tuple (round 2, F1). */
export function differingFields(base, branch) {
  return RECORD_FIELDS.filter((field) => base[field] !== branch[field]);
}

/**
 * E8.2a's per-record classification of the merge base against the branch over one layer. A base
 * record that is not a path failure (ok, or any other code such as META) must be equal in every
 * field; a base path failure may become `ok` or another path failure (an allowed change, listed
 * with both codes) and otherwise is an internal-regression. A record missing from the branch or
 * only on the branch is a FAIL. `fail` includes `internalRegression`.
 */
export function classifyFailureToSuccessLayer(layer, base, branch) {
  const result = {
    counts: { identical: 0, allowedChange: 0, fail: 0, internalRegression: 0 },
    allowed: [],
    fails: [],
    internalRegressions: [],
  };
  const fail = (name, reason) => {
    result.counts.fail += 1;
    result.fails.push({ layer, case: name, reason });
  };
  for (const [name, old] of base) {
    const current = branch.get(name);
    if (current === undefined) {
      fail(name, 'missing on the branch');
      continue;
    }
    const differing = differingFields(old, current);
    if (classifyOutcome(old.code) !== 'path-failure') {
      if (differing.length === 0) result.counts.identical += 1;
      else
        fail(
          name,
          `${old.code} record differs in ${differing.join(', ')} (${old.code} -> ${current.code})`,
        );
      continue;
    }
    if (differing.length === 0) {
      result.counts.identical += 1;
      continue;
    }
    const outcome = classifyOutcome(current.code);
    if (outcome === 'ok' || outcome === 'path-failure' || outcome === 'empty') {
      result.counts.allowedChange += 1;
      result.allowed.push({ layer, case: name, baseCode: old.code, branchCode: current.code });
    } else {
      const reason = `${old.code} became ${outcome} ${current.code}`;
      result.counts.internalRegression += 1;
      result.internalRegressions.push({ layer, case: name, reason });
      fail(name, `internal-regression: ${reason}`);
    }
  }
  for (const name of branch.keys()) if (!base.has(name)) fail(name, 'only on the branch');
  return result;
}

/** Both layers: `input` is { native: { base, branch }, wasm: { base, branch } }. */
export function classifyFailureToSuccess(input) {
  const layers = [
    classifyFailureToSuccessLayer('native', input.native.base, input.native.branch),
    classifyFailureToSuccessLayer('wasm', input.wasm.base, input.wasm.branch),
  ];
  const counts = { identical: 0, allowedChange: 0, fail: 0, internalRegression: 0 };
  for (const layer of layers)
    for (const key of Object.keys(counts)) counts[key] += layer.counts[key];
  const fails = layers.flatMap((layer) => layer.fails);
  return {
    counts,
    perLayer: { native: layers[0].counts, wasm: layers[1].counts },
    allowed: layers.flatMap((layer) => layer.allowed),
    fails,
    internalRegressions: layers.flatMap((layer) => layer.internalRegressions),
    failures: fails.map((item) => `${item.layer}: ${item.case}: ${item.reason}`),
    pass: counts.fail === 0,
  };
}

/**
 * The full run's tamper self-check in failure-to-success mode: the branch digest of one native
 * and one WASM case whose base record is `ok`, each tampered on its own, must be reported as a
 * FAIL naming that case.
 */
export function failureToSuccessTamperChecks(input) {
  const pick = (layer) =>
    [...input[layer].base].find(
      ([name, entry]) => classifyOutcome(entry.code) === 'ok' && input[layer].branch.has(name),
    )?.[0];
  return ['native', 'wasm'].map((layer) => {
    const name = pick(layer);
    if (name === undefined) return { case: null, detected: false };
    const tampered = {
      ...input,
      [layer]: { ...input[layer], branch: tamper(input[layer].branch, name) },
    };
    const { fails } = classifyFailureToSuccess(tampered);
    return {
      case: name,
      detected: fails.some((item) => item.layer === layer && item.case === name),
    };
  });
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

function reportFailureToSuccess(result) {
  const { counts } = result;
  console.log(
    `P3 B0R identity: failure-to-success identical ${counts.identical}, allowed change ${counts.allowedChange}, FAIL ${counts.fail} (internal-regression ${counts.internalRegression})`,
  );
  for (const item of result.allowed.slice(0, 25))
    console.log(
      `  allowed change ${item.layer} ${item.case}: ${item.baseCode} -> ${item.branchCode}`,
    );
  for (const failure of result.failures.slice(0, 25))
    console.error(`P3 B0R identity: failure-to-success FAIL ${failure}`);
}

/** The classification counts and the full list of allowed changes, for the run directory. */
function failureToSuccessRecord(result) {
  return {
    counts: result.counts,
    perLayer: result.perLayer,
    allowedChanges: result.allowed,
    internalRegressions: result.internalRegressions,
    fails: result.fails,
    pass: result.pass,
  };
}

function compareOnly(directory, tamperCase, revisionChange, failureToSuccess = false) {
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
    `P3 B0R identity (compare-only${revisionChange ? ', revision-change' : ''}${failureToSuccess ? ', failure-to-success' : ''}): ${native.base.size} native and ${wasm.base.size} WASM cases`,
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
  if (failureToSuccess) {
    const result = classifyFailureToSuccess({ native, wasm });
    reportFailureToSuccess(result);
    if (tamperCase === null && existsSync(directory))
      writeFileSync(
        path.join(directory, 'failure-to-success.json'),
        `${JSON.stringify(failureToSuccessRecord(result), null, 2)}\n`,
      );
    return cross.equal && revisionFailures.length === 0 && result.pass;
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
function selfTestRevisionChange() {
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
    // The full run's revision-change tamper checks (AL-U3): an AL-I1 entry case and an
    // unchanged WASM case, each tampered, must be reported by name.
    const load = (name) => parseNativeDigests(readFileSync(path.join(directory, name), 'utf8'));
    const tamperChecks = revisionTamperChecks({
      native: { base: load('native-base.tsv'), branch: load('native-branch.tsv') },
      wasm: { base: load('wasm-base.tsv'), branch: load('wasm-branch.tsv') },
      rungs: parseRungRecord(readFileSync(path.join(directory, 'rungs-branch.tsv'), 'utf8')),
    });
    const tampers =
      tamperChecks.length === 2 &&
      tamperChecks.every((check) => check.detected) &&
      tamperChecks[0].case === 'rnd/T/0000/attempt' &&
      tamperChecks[1].case === 'wasm/rnd/T/0000';
    write('revisions.json', JSON.stringify({ base: 1, branch: 1 }));
    const unrevised = compareOnly(directory, null, true);
    const plain = compareOnly(directory, null, false);
    const pass = clean && !seeded && tampers && !unrevised && !plain;
    console.log(
      `P3 B0R identity self-test: clean revision-change ${clean ? 'PASS' : 'FAIL'}; seeded unexpected change ${seeded ? 'NOT DETECTED' : 'detected'}; revision-change tamper checks ${tamperChecks.map((check) => `${check.case} ${check.detected ? 'detected' : 'NOT DETECTED'}`).join(', ')}; revision not base + 1 ${unrevised ? 'NOT DETECTED' : 'detected'}; plain mode on changed cases ${plain ? 'NOT DETECTED' : 'detected'}; ${pass ? 'PASS' : 'FAIL'}`,
    );
    return pass;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The `--failure-to-success` self-test (E8.2a) on synthetic records, no kernel needed. Every
 * tamper case below must be classified as stated; a case that is not detected fails the test.
 * The digests are built from separate diagnostics, statistics, boundary and mesh parts, so a
 * digest change in one part with the mesh bytes unchanged is exercised (round 2, F2).
 */
function selfTestFailureToSuccess() {
  const digest = ({
    diagnostics = 'diag0',
    stats = 'stats0',
    boundary = 'boundary0',
    mesh = 'mesh0',
    label = 'ok',
  } = {}) =>
    sha256(
      `${label}\ndiagnostics=${diagnostics}\nstats=${stats}\nboundary=${boundary}\nmesh=${mesh}`,
    );
  const record = (parts, code = 'path_status=0', allocations = 0, crossings = 0) => ({
    digest: digest(parts),
    allocations,
    code,
    crossings,
  });
  const failed = (label, code) => record({ label }, code);
  const A = 'rnd/T/0000/fill_v0_cascade';
  const WA = 'wasm/rnd/T/0000';
  const nativeBase = () =>
    new Map([
      ['meta/cubic-workspace-sizes', record({ label: 'meta' }, 'META')],
      ['rnd/T/0000/attempt', record({ label: 'attempt' }, 'OK', 0, 3)],
      [A, record({}, 'path_status=0', 0, 2)],
      ['rnd/T/0001/fill_v0_cascade', failed('f1', 'path_status=6')],
      ['rnd/T/0002/fill_v0_cascade', failed('f2', 'path_status=5')],
      ['rnd/T/0003/attempt', failed('f3', 'Topology(KnotMismatch)')],
      ['rnd/T/0004/attempt', failed('e4', 'NO_MESH(flat_status=1)')],
      ['rnd/T/0005/fill_v0_cascade', failed('e3', 'path_status=1')],
    ]);
  const wasmBase = () =>
    new Map([
      [WA, record({}, 'path_status=0', 0, 2)],
      ['wasm/rnd/T/0001', failed('f1', 'path_status=6')],
      ['wasm/rnd/T/0002', failed('f2', 'path_status=5')],
    ]);
  const classify = (change) => {
    const native = { base: nativeBase(), branch: nativeBase() };
    const wasm = { base: wasmBase(), branch: wasmBase() };
    change(native.branch, wasm.branch);
    return classifyFailureToSuccess({ native, wasm });
  };
  const withFields = (map, name, fields) => map.set(name, { ...map.get(name), ...fields });
  // [label, change, expectation]: counts of allowed, fail and internal-regression, and the cases
  // that the FAIL list must name.
  const cases = [
    ['unchanged branch', () => {}, { allowed: 0, fail: 0, internal: 0, names: [] }],
    [
      'allowed: failure becomes ok or another failure',
      (n, w) => {
        n.set('rnd/T/0001/fill_v0_cascade', record({ label: 'new1' }, 'path_status=0', 0, 1));
        n.set('rnd/T/0003/attempt', failed('f3b', 'Rounded(WorkLimit)'));
        w.set('wasm/rnd/T/0002', failed('f2b', 'path_status=6'));
      },
      { allowed: 3, fail: 0, internal: 0, names: [] },
    ],
    [
      'FAIL: one mesh byte of an ok record',
      (n) => n.set(A, record({ mesh: 'mesh1' }, 'path_status=0', 0, 2)),
      { allowed: 0, fail: 1, internal: 0, names: [A] },
    ],
    [
      'FAIL: ok record becomes a failure',
      (n, w) => w.set(WA, failed('gone', 'path_status=6')),
      { allowed: 0, fail: 1, internal: 0, names: [WA] },
    ],
    [
      'FAIL: ok record with a changed boundary pair',
      (n) => n.set(A, record({ boundary: 'boundary1' }, 'path_status=0', 0, 2)),
      { allowed: 0, fail: 1, internal: 0, names: [A] },
    ],
    [
      'FAIL: diagnostics-only digest change, same mesh bytes',
      (n) => n.set(A, record({ diagnostics: 'diag1' }, 'path_status=0', 0, 2)),
      { allowed: 0, fail: 1, internal: 0, names: [A] },
    ],
    [
      'FAIL: statistics-only digest change, same mesh bytes',
      (n) => n.set(A, record({ stats: 'stats1' }, 'path_status=0', 0, 2)),
      { allowed: 0, fail: 1, internal: 0, names: [A] },
    ],
    [
      'FAIL: allocations change with equal digest',
      (n) => withFields(n, A, { allocations: 1 }),
      { allowed: 0, fail: 1, internal: 0, names: [A] },
    ],
    [
      'FAIL: crossings change with equal digest',
      (n) => withFields(n, A, { crossings: 3 }),
      { allowed: 0, fail: 1, internal: 0, names: [A] },
    ],
    [
      'FAIL: ok code changes with equal digest (OK to path_status=0)',
      (n) => withFields(n, 'rnd/T/0000/attempt', { code: 'path_status=0' }),
      { allowed: 0, fail: 1, internal: 0, names: ['rnd/T/0000/attempt'] },
    ],
    [
      'FAIL: META record differs',
      (n) => n.set('meta/cubic-workspace-sizes', record({ label: 'meta2' }, 'META')),
      { allowed: 0, fail: 1, internal: 0, names: ['meta/cubic-workspace-sizes'] },
    ],
    [
      'FAIL: missing record (native and WASM)',
      (n, w) => {
        n.delete(A);
        w.delete(WA);
      },
      { allowed: 0, fail: 2, internal: 0, names: [A, WA] },
    ],
    [
      'FAIL: record only on the branch',
      (n) => n.set('rnd/T/0009/fill_v0_cascade', record({ label: 'extra' })),
      { allowed: 0, fail: 1, internal: 0, names: ['rnd/T/0009/fill_v0_cascade'] },
    ],
    [
      'internal-regression: path failure becomes an internal error',
      (n) => n.set('rnd/T/0003/attempt', failed('f3c', 'Rounded(InternalInvariant)')),
      { allowed: 0, fail: 1, internal: 1, names: ['rnd/T/0003/attempt'] },
    ],
    [
      'internal-regression: path failure becomes a batch failure',
      (n, w) => w.set('wasm/rnd/T/0001', failed('f1c', 'batch_status=6')),
      { allowed: 0, fail: 1, internal: 1, names: ['wasm/rnd/T/0001'] },
    ],
    [
      'internal-regression: path failure becomes an unrecognized code',
      (n) => n.set('rnd/T/0001/fill_v0_cascade', failed('f1d', 'Mystery(7)')),
      { allowed: 0, fail: 1, internal: 1, names: ['rnd/T/0001/fill_v0_cascade'] },
    ],
    [
      'allowed: path failure becomes empty (path_status=1 and NO_MESH(flat_status=1))',
      (n, w) => {
        n.set('rnd/T/0003/attempt', failed('e1', 'NO_MESH(flat_status=1)'));
        w.set('wasm/rnd/T/0002', failed('e2', 'path_status=1'));
      },
      { allowed: 2, fail: 0, internal: 0, names: [] },
    ],
    [
      'FAIL: base empty (path_status=1) becomes a failure or ok',
      (n) => n.set('rnd/T/0005/fill_v0_cascade', failed('e3', 'path_status=6')),
      { allowed: 0, fail: 1, internal: 0, names: ['rnd/T/0005/fill_v0_cascade'] },
    ],
    [
      'FAIL: base empty (NO_MESH(flat_status=1)) becomes ok',
      (n) => n.set('rnd/T/0004/attempt', record('k', 'OK')),
      { allowed: 0, fail: 1, internal: 0, names: ['rnd/T/0004/attempt'] },
    ],
    [
      'FAIL: unchanged-code base empty with a changed digest',
      (n) => n.set('rnd/T/0004/attempt', failed('e5', 'NO_MESH(flat_status=1)')),
      { allowed: 0, fail: 1, internal: 0, names: ['rnd/T/0004/attempt'] },
    ],
    [
      'FAIL, not internal-regression: ok record becomes an internal error',
      (n) => n.set(A, failed('boom', 'EmissionStatus(5)')),
      { allowed: 0, fail: 1, internal: 0, names: [A] },
    ],
  ];
  let pass = true;
  for (const [label, change, expected] of cases) {
    const result = classify(change);
    const named = expected.names.every((name) => result.fails.some((item) => item.case === name));
    const good =
      result.counts.allowedChange === expected.allowed &&
      result.counts.fail === expected.fail &&
      result.counts.internalRegression === expected.internal &&
      result.fails.length === expected.fail &&
      named &&
      result.pass === (expected.fail === 0);
    pass &&= good;
    console.log(
      `P3 B0R identity self-test (failure-to-success) ${good ? 'ok' : 'WRONG'}: ${label}: allowed ${result.counts.allowedChange}, FAIL ${result.counts.fail} (internal-regression ${result.counts.internalRegression}), ${result.pass ? 'pass' : 'fail'}`,
    );
  }
  // The tamper checks of the full run, on records that include an ok case in each layer.
  const tamperChecks = failureToSuccessTamperChecks({
    native: { base: nativeBase(), branch: nativeBase() },
    wasm: { base: wasmBase(), branch: wasmBase() },
  });
  const tampers = tamperChecks.length === 2 && tamperChecks.every((check) => check.detected);
  pass &&= tampers;
  console.log(
    `P3 B0R identity self-test (failure-to-success) full-run tamper checks: ${tamperChecks.map((check) => `${check.case} ${check.detected ? 'detected' : 'NOT DETECTED'}`).join(', ')}`,
  );

  // The compare-only plumbing on a synthetic run directory: --failure-to-success on an
  // unchanged branch, on an allowed change (plain mode must refuse it), and --tamper.
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(path.join(temporary, 'p3-fill-identity-f2s-self-test-'));
  try {
    const rows = (map) =>
      `${[...map]
        .map(
          ([name, entry]) =>
            `${name}\t${entry.digest}\t${entry.allocations}\t${entry.code}\t${entry.crossings}`,
        )
        .join('\n')}\n`;
    const files = (nativeBranch, wasmBranch) => {
      writeFileSync(path.join(directory, 'native-base.tsv'), rows(nativeBase()));
      writeFileSync(path.join(directory, 'native-branch.tsv'), rows(nativeBranch));
      writeFileSync(path.join(directory, 'wasm-base.tsv'), rows(wasmBase()));
      writeFileSync(path.join(directory, 'wasm-branch.tsv'), rows(wasmBranch));
    };
    // The WASM cascade digests must equal the native ones, as in a real run.
    const wasmOf = (native, entries) => {
      const map = new Map();
      for (const [wasmName, nativeName] of entries) map.set(wasmName, native.get(nativeName));
      return map;
    };
    const entries = [
      [WA, A],
      ['wasm/rnd/T/0001', 'rnd/T/0001/fill_v0_cascade'],
      ['wasm/rnd/T/0002', 'rnd/T/0002/fill_v0_cascade'],
    ];
    const baseNative = nativeBase();
    const baseWasm = wasmOf(baseNative, entries);
    files(baseNative, baseWasm);
    const cleanBranch = compareOnly(directory, null, false, true);
    const cleanPlain = compareOnly(directory, null, false, false);
    const allowedNative = nativeBase();
    allowedNative.set('rnd/T/0001/fill_v0_cascade', record({ label: 'new1' }));
    allowedNative.set('rnd/T/0003/attempt', failed('f3b', 'Rounded(WorkLimit)'));
    files(allowedNative, wasmOf(allowedNative, entries));
    const allowedMode = compareOnly(directory, null, false, true);
    const allowedPlain = compareOnly(directory, null, false, false);
    const tamperedOk = compareOnly(directory, A, false, true);
    const plumbing = cleanBranch && cleanPlain && allowedMode && !allowedPlain && !tamperedOk;
    pass &&= plumbing;
    console.log(
      `P3 B0R identity self-test (failure-to-success) compare-only: unchanged ${cleanBranch ? 'pass' : 'FAIL'}; allowed change ${allowedMode ? 'pass' : 'FAIL'} (plain mode ${allowedPlain ? 'NOT DETECTED' : 'refuses it'}); --tamper ${tamperedOk ? 'NOT DETECTED' : 'detected'}; ${plumbing ? 'ok' : 'WRONG'}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(`P3 B0R identity self-test (failure-to-success): ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

function selfTest() {
  const revisionChange = selfTestRevisionChange();
  const failureToSuccess = selfTestFailureToSuccess();
  return revisionChange && failureToSuccess;
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
    `P3 B0R identity: base ${baseCommit}, head ${headCommit}, mode ${options.revisionChange ? 'revision-change' : options.failureToSuccess ? 'failure-to-success' : 'plain'}, output ${path.relative(root, output)}`,
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
    let revisionInput = null;
    let f2sInput = null;
    let failureToSuccess = null;
    if (options.revisionChange) {
      const rungs = timed(durations, 'rungRecordMs', () =>
        dumpRungs(corpora, path.join(output, 'rungs-branch.tsv'), options.threads),
      );
      const input = (revisionInput = {
        native: { base: native.base, branch: native.branch },
        wasm: { base: wasm.base, branch: wasm.branch },
        rungs,
      });
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
    } else if (options.failureToSuccess) {
      f2sInput = {
        native: { base: native.base, branch: native.branch },
        wasm: { base: wasm.base, branch: wasm.branch },
      };
      const result = classifyFailureToSuccess(f2sInput);
      reportFailureToSuccess(result);
      writeFileSync(
        path.join(output, 'failure-to-success.json'),
        `${JSON.stringify(failureToSuccessRecord(result), null, 2)}\n`,
        { flag: 'wx' },
      );
      failures.push(...result.failures.map((failure) => `failure-to-success: ${failure}`));
      failureToSuccess = failureToSuccessRecord(result);
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
    // Revision-change mode tampers an AL-I1 entry case and an unchanged WASM case and needs the
    // classification to report each (AL-U3); plain mode keeps its exactly-one-difference check.
    const tamperChecks = options.revisionChange
      ? revisionTamperChecks(revisionInput)
      : options.failureToSuccess
        ? failureToSuccessTamperChecks(f2sInput)
        : [
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
      mode: options.revisionChange
        ? 'revision-change'
        : options.failureToSuccess
          ? 'failure-to-success'
          : 'plain',
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
      ...(failureToSuccess === null ? {} : { failureToSuccess }),
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
    ? compareOnly(
        path.resolve(options.compareOnly),
        options.tamper,
        options.revisionChange,
        options.failureToSuccess,
      )
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
