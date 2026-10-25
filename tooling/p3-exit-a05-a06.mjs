// X1 A05/A06 evidence helpers (docs/plans/d9-e11-p3-c03-c05-closure-contract.md, section 7).
// Pure functions over tooling/p3-exit-a05-a06-map.json and parsed test results; the runner is
// tooling/run-p3-exit-a05-a06.mjs.

const RUNNERS = new Set(['cargo', 'unit', 'geometry', 'headed']);
const KINDS = new Set(['required', 'supplementary', 'headed']);

/** Lists every map problem that can be seen without running a test. */
export function checkMap(map, { exists, read }) {
  const problems = [];
  if (map.version !== 'p3-exit-a05-a06-map/v1') problems.push(`unknown version ${map.version}`);
  for (const criterion of ['A05', 'A06']) {
    const entries = map.criteria?.[criterion];
    if (!Array.isArray(entries) || entries.length === 0) {
      problems.push(`${criterion}: no entries`);
      continue;
    }
    const ids = new Set();
    for (const entry of entries) {
      const at = `${criterion} ${entry.id}`;
      if (ids.has(entry.id)) problems.push(`${at}: duplicate id`);
      ids.add(entry.id);
      if (!KINDS.has(entry.kind)) problems.push(`${at}: unknown kind ${entry.kind}`);
      if (!RUNNERS.has(entry.runner)) problems.push(`${at}: unknown runner ${entry.runner}`);
      if ((entry.kind === 'headed') !== (entry.runner === 'headed'))
        problems.push(`${at}: kind headed and runner headed go together`);
      if (!exists(entry.source)) problems.push(`${at}: source ${entry.source} is missing`);
      if (entry.runner === 'cargo') {
        if (typeof entry.filter !== 'string' || !entry.filter.endsWith('_tests::'))
          problems.push(`${at}: a cargo entry filters one test module (name ending _tests::)`);
        else if (
          !read('packages/geometry-wasm/kernel/src/lib.rs').includes(
            `mod ${entry.filter.slice(0, -2)};`,
          )
        )
          problems.push(`${at}: kernel has no module ${entry.filter.slice(0, -2)}`);
        continue;
      }
      if (!exists(entry.file)) {
        problems.push(`${at}: file ${entry.file} is missing`);
        continue;
      }
      if (entry.each !== undefined) {
        if (!Array.isArray(entry.each) || entry.each.length === 0)
          problems.push(`${at}: each must list at least one title prefix`);
        else if (new Set(entry.each).size !== entry.each.length)
          problems.push(`${at}: each has a duplicate prefix`);
      }
    }
  }
  return problems;
}

/** Parses libtest output lines `test <name> ... ok|FAILED|ignored`. */
export function parseCargoTests(stdout) {
  const tests = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/u.exec(line);
    if (match) tests.push({ name: match[1], status: match[2] === 'ok' ? 'passed' : match[2] });
  }
  return tests;
}

/** Flattens a Vitest JSON report into { file, title, fullName, status } with repo-relative files. */
export function vitestTests(report, root) {
  const base = `${root.replaceAll('\\', '/').replace(/\/+$/u, '')}/`;
  // Windows drive letters and paths compare without case.
  const normalize = (file) => {
    const slashed = file.replaceAll('\\', '/');
    return slashed.toLowerCase().startsWith(base.toLowerCase())
      ? slashed.slice(base.length)
      : slashed;
  };
  return report.testResults.flatMap((fileResult) =>
    fileResult.assertionResults.map((test) => ({
      file: normalize(fileResult.name),
      title: test.title,
      fullName: test.fullName,
      status: test.status,
    })),
  );
}

/**
 * Finds the E11 exit snapshot record whose commit starts with `label` (E11 section 3.2): a line
 * with "**Exit snapshot record**", a date and that commit, together with the lines after it up to
 * the next heading or record. The sentence that defines the record carries no date and no commit,
 * so it never matches. Returns the record block, or the reason there is none.
 */
export function findSnapshotRecord(contract, label) {
  const lines = contract.split(/\r?\n/u);
  const marker = '**Exit snapshot record**';
  const start = lines.findIndex(
    (line) =>
      line.includes(marker) &&
      /\b20\d\d-\d\d-\d\d\b/u.test(line) &&
      [...line.matchAll(/\b[0-9a-f]{7,40}\b/gu)].some((m) => m[0].startsWith(label)),
  );
  if (start < 0)
    return { error: `E11 has no dated "${marker}" line naming commit ${label} (section 3.2)` };
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('#') && !lines[end].includes(marker)) end++;
  return { block: lines.slice(start, end).join('\n') };
}

/** Lists the run identities that the snapshot record block does not name. */
export function identityMismatches(block, identities) {
  return ['Fill operation', 'Stroke operation', 'Release WASM SHA-256']
    .filter((key) => !block.toLowerCase().includes(String(identities[key]).toLowerCase()))
    .map((key) => `${key} ${identities[key]} is not in the snapshot record`);
}

/**
 * Decides each entry: it holds when it selects at least one test, every selected test passed, and
 * every `each` prefix selects at least one test. A failure of the run itself (a suite that did not
 * load) fails every entry of that runner.
 */
export function evaluate(map, results) {
  const rows = [];
  for (const criterion of ['A05', 'A06']) {
    for (const entry of map.criteria[criterion]) {
      if (entry.runner === 'headed') {
        rows.push({ criterion, entry, verdict: 'HEADED', selected: 0, failures: [] });
        continue;
      }
      const run = results[entry.runner];
      if (!run || run.ok === false) {
        rows.push({
          criterion,
          entry,
          verdict: 'FAIL',
          selected: 0,
          failures: [`${entry.runner} run ${run ? 'failed' : 'missing'}`],
        });
        continue;
      }
      const selected =
        entry.runner === 'cargo'
          ? run.tests.filter((test) => test.name.startsWith(entry.filter))
          : run.tests
              .filter((test) => test.file === entry.file)
              .filter(
                (test) =>
                  entry.each === undefined ||
                  entry.each.some((prefix) => test.title.startsWith(prefix)),
              );
      const failures = selected
        .filter((test) => test.status !== 'passed')
        .map((test) => `${test.name ?? test.fullName ?? test.title}: ${test.status}`);
      if (selected.length === 0) failures.push('no test selected');
      for (const prefix of entry.each ?? [])
        if (!selected.some((test) => test.title.startsWith(prefix)))
          failures.push(`no test titled "${prefix.trim()}..."`);
      rows.push({
        criterion,
        entry,
        verdict: failures.length === 0 ? 'PASS' : 'FAIL',
        selected: selected.length,
        failures,
      });
    }
  }
  const required = rows.filter((row) => row.entry.kind === 'required');
  return {
    rows,
    criteria: Object.fromEntries(
      ['A05', 'A06'].map((criterion) => {
        const mine = required.filter((row) => row.criterion === criterion);
        const headed = rows.some((row) => row.criterion === criterion && row.verdict === 'HEADED');
        const verdict = mine.every((row) => row.verdict === 'PASS')
          ? headed
            ? 'PASS (CI part; headed part cited separately)'
            : 'PASS'
          : 'FAIL';
        return [criterion, verdict];
      }),
    ),
  };
}

/** Renders the evaluation as the Markdown table the record copies. */
export function renderMarkdown(evaluation, provenance) {
  const lines = [
    `Label: **${provenance.label}**`,
    '',
    '| Identity | Value |',
    '| --- | --- |',
    ...Object.entries(provenance.identities).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '| Criterion | Entry | Kind | Runner | Tests | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...evaluation.rows.map(
      (row) =>
        `| ${row.criterion} | ${row.entry.id} | ${row.entry.kind} | ${row.entry.runner} | ${row.selected} | ${row.verdict}${row.failures.length ? `: ${row.failures.join('; ')}` : ''} |`,
    ),
    '',
    ...Object.entries(evaluation.criteria).map(
      ([criterion, verdict]) => `- ${criterion}: ${verdict}`,
    ),
    '',
  ];
  return lines.join('\n');
}
