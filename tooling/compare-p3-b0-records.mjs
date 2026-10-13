// B0R unit U8 tooling: compares two P3 B0 result records (the 2026-10-12 record and the B0R
// remeasure). Frozen by docs/plans/p3-b0r-kernel-performance-contract.md section 8 items 4 and 6.
//
//   node tooling/compare-p3-b0-records.mjs --old <old.json> --new <new.json> [--markdown <out.md>]
//
// 1. Identity cross-check (item 4): the fields a bit-identical kernel must reproduce are compared
//    for equality; every difference is listed and the exit code is 1. Timings, environment, run
//    id, source commit and other fields that legitimately differ are never compared.
// 2. Comparison report (item 6): derived only from the two records. Both records pass
//    `validateRecord` on load, and every table comes from `analyze(record)`, the same function
//    that produced each record's stored analysis. `analysis.ts` is erasable TypeScript, so Node
//    loads it directly, as tooling/run-p3-b0-benchmark.mjs does.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { analyze, canonicalJson, configHash, validateRecord } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/analysis.ts')).href
);

const H1_CAVEAT =
  'Contract section 3.1: after B0R the exact share measures the residual exact work that the filters could not avoid, so H1 values are not comparable with the first record.';

export function parseArguments(args) {
  const options = { old: null, new: null, markdown: null };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const key = { '--old': 'old', '--new': 'new', '--markdown': 'markdown' }[name];
    if (key === undefined) throw new Error(`unknown argument ${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    options[key] = value;
    index += 1;
  }
  if (options.old === null || options.new === null)
    throw new Error('usage: --old <old.json> --new <new.json> [--markdown <out.md>]');
  return options;
}

/** Reads a record and rejects it unless `validateRecord` accepts it. */
export function loadRecord(file) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  validateRecord(record);
  return record;
}

const sortedRepetitions = (record) =>
  [...record.repetitions].sort((left, right) => left.repetition - right.repetition);

const withoutAllocations = (cell) =>
  cell === undefined
    ? undefined
    : {
        cell: cell.cell,
        paths: cell.paths.map((entry) => ({ ...entry, allocations: 0 })),
      };

/** The hash analyze() prints as "first admission hash": over repetition 0's full admission. */
function firstAdmissionHash(record) {
  const first = sortedRepetitions(record)[0];
  return configHash(canonicalJson(first?.admission ?? [])).slice(0, 12);
}

export const PINNED_CONFIG_HASH =
  'a10c98e9c732929b2752a7349486cbd95e31cc02018d3c703011543483d29271';
export const PINNED_CORPUS_SHA256 =
  '206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796';

const byCell = (list) => new Map(list.map((item) => [item.cell, item]));

/**
 * Section 8 item 4. Returns `{ pass, differences }`, each difference `{ field, old, new }`.
 * Compared: scenario id/version, configuration hash, runner id, corpus SHA-256, the first
 * admission hash, per repetition the admission/topology-mix results (and allocation counts),
 * every cell's batch checksums and the linearity checksums, and the diagnostic O1/O2
 * observation tables.
 */
export function identityCheck(oldRecord, newRecord) {
  const differences = [];
  const compare = (field, left, right) => {
    const a = canonicalJson(left ?? null);
    const b = canonicalJson(right ?? null);
    if (a !== b) differences.push({ field, old: a, new: b });
  };
  compare('scenario.id', oldRecord.scenario.id, newRecord.scenario.id);
  compare('scenario.version', oldRecord.scenario.version, newRecord.scenario.version);
  compare('scenario.configHash', oldRecord.scenario.configHash, newRecord.scenario.configHash);
  compare('run.runner', oldRecord.run.runner, newRecord.run.runner);
  compare('corpus.sha256', oldRecord.corpus.sha256, newRecord.corpus.sha256);
  // Section 8 item 3 pins both values; a record that differs is not this remeasure.
  for (const [label, record] of [
    ['old', oldRecord],
    ['new', newRecord],
  ]) {
    compare(
      `${label} scenario.configHash vs section 8`,
      PINNED_CONFIG_HASH,
      record.scenario.configHash,
    );
    compare(`${label} corpus.sha256 vs section 8`, PINNED_CORPUS_SHA256, record.corpus.sha256);
  }
  compare('firstAdmissionHash', firstAdmissionHash(oldRecord), firstAdmissionHash(newRecord));

  const oldReps = sortedRepetitions(oldRecord);
  const newReps = sortedRepetitions(newRecord);
  compare(
    'repetitions.indices',
    oldReps.map((rep) => rep.repetition),
    newReps.map((rep) => rep.repetition),
  );
  for (const oldRep of oldReps) {
    const newRep = newReps.find((rep) => rep.repetition === oldRep.repetition);
    if (!newRep) continue;
    const at = `repetitions[${oldRep.repetition}]`;
    // Admission includes the topology mix: status, rounded, transverse, sizes per path.
    const oldAdmission = byCell(oldRep.admission);
    const newAdmission = byCell(newRep.admission);
    for (const cell of new Set([...oldAdmission.keys(), ...newAdmission.keys()])) {
      compare(
        `${at}.admission[${cell}]`,
        withoutAllocations(oldAdmission.get(cell)),
        withoutAllocations(newAdmission.get(cell)),
      );
      const oldPaths = oldAdmission.get(cell)?.paths ?? [];
      const newPaths = newAdmission.get(cell)?.paths ?? [];
      for (let index = 0; index < Math.max(oldPaths.length, newPaths.length); index += 1)
        compare(
          `${at}.admission[${cell}].paths[${index}].allocations`,
          oldPaths[index]?.allocations,
          newPaths[index]?.allocations,
        );
    }
    const oldCells = byCell(oldRep.cells);
    const newCells = byCell(newRep.cells);
    for (const cell of new Set([...oldCells.keys(), ...newCells.keys()]))
      compare(
        `${at}.cells[${cell}].checksums`,
        oldCells.get(cell)?.checksums,
        newCells.get(cell)?.checksums,
      );
    compare(`${at}.linearity.cell`, oldRep.linearity?.cell, newRep.linearity?.cell);
    compare(
      `${at}.linearity.checksums10`,
      oldRep.linearity?.checksums10,
      newRep.linearity?.checksums10,
    );
    compare(
      `${at}.linearity.checksums100`,
      oldRep.linearity?.checksums100,
      newRep.linearity?.checksums100,
    );
  }
  // O1/O2 observation tables: the diagnostic build's admission of the observation cells.
  const oldObs = byCell(oldRecord.diagnostic?.observations ?? []);
  const newObs = byCell(newRecord.diagnostic?.observations ?? []);
  compare('diagnostic.present', oldRecord.diagnostic !== null, newRecord.diagnostic !== null);
  for (const cell of new Set([...oldObs.keys(), ...newObs.keys()]))
    compare(
      `diagnostic.observations[${cell}]`,
      withoutAllocations(oldObs.get(cell)),
      withoutAllocations(newObs.get(cell)),
    );
  return { pass: differences.length === 0, differences };
}

const ratio = (before, after) =>
  before === null || before === undefined || after === null || after === undefined || before === 0
    ? null
    : after / before;

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.5 * sorted.length) - 1];
};

const pair = (before, after) => ({
  old: before ?? null,
  new: after ?? null,
  ratio: ratio(before, after),
});

/** Section 8 item 6: every number comes from analyze() of the two records. */
export function compareRecords(oldRecord, newRecord) {
  const oldAnalysis = analyze(oldRecord);
  const newAnalysis = analyze(newRecord);
  const newCells = new Map(newAnalysis.perCell.map((cell) => [cell.cell, cell]));
  const cellMedian = (cell, field) =>
    cell && cell.perRepetition.length > 0
      ? median(cell.perRepetition.map((item) => item[field].median))
      : null;
  const cells = oldAnalysis.perCell.map((cell) => ({
    cell: cell.cell,
    series: cell.series,
    leaves: cell.leaves,
    batchMedianNs: pair(cellMedian(cell, 'batch'), cellMedian(newCells.get(cell.cell), 'batch')),
    pathMedianNs: pair(cellMedian(cell, 'path'), cellMedian(newCells.get(cell.cell), 'path')),
  }));
  const fitKey = (fit) => `${fit.series}|${fit.kind}|${fit.repetition}`;
  const newFits = new Map(newAnalysis.fits.map((fit) => [fitKey(fit), fit]));
  const fits = oldAnalysis.fits.map((fit) => ({
    series: fit.series,
    kind: fit.kind,
    repetition: fit.repetition,
    slope: pair(fit.slope, newFits.get(fitKey(fit))?.slope),
    estimateNs: pair(fit.estimateNs, newFits.get(fitKey(fit))?.estimateNs),
  }));
  const oe = oldAnalysis.estimates;
  const ne = newAnalysis.estimates;
  const estimates = {
    perPathNs: pair(oe?.perPathNs, ne?.perPathNs),
    initialMs: pair(oe?.initialMs, ne?.initialMs),
    editMs: pair(oe?.editMs, ne?.editMs),
    meshBytes: pair(oe?.meshBytes, ne?.meshBytes),
  };
  const newH1 = new Map((newAnalysis.h1 ?? []).map((item) => [item.series, item]));
  const stages = (oldAnalysis.h1 ?? []).map((item) => {
    const other = newH1.get(item.series);
    const stage = (name) => pair(item.stagesNs?.[name], other?.stagesNs?.[name]);
    return {
      series: item.series,
      oldCell: item.cell,
      newCell: other?.cell ?? null,
      flatten: stage('flatten'),
      topology: stage('topology'),
      tessellation: stage('tessellation'),
      total: stage('total'),
      exactShare: pair(item.exactShare, other?.exactShare),
      overhead: pair(item.overhead, other?.overhead),
      h1Verdict: { old: item.verdict, new: other?.verdict ?? null },
    };
  });
  const describeChecks = (analysis) =>
    analysis.checks.map((item) => `${item.id}: ${item.pass ? 'pass' : 'FAIL'} (${item.detail})`);
  return {
    verdict: { old: oldAnalysis.verdict, new: newAnalysis.verdict },
    checks: { old: describeChecks(oldAnalysis), new: describeChecks(newAnalysis) },
    cells,
    fits,
    estimates,
    stages,
    h1Caveat: H1_CAVEAT,
  };
}

const format = (value, digits = 4) =>
  value === null || value === undefined ? '-' : Number(value.toPrecision(digits)).toString();
const pairRow = (label, entry, digits) => [
  label,
  format(entry.old, digits),
  format(entry.new, digits),
  format(entry.ratio, 4),
];
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
  '',
];

export function renderMarkdown(report, identity, names = { old: 'old', new: 'new' }) {
  const lines = [
    '# P3 B0 record comparison',
    '',
    `Old: ${names.old}. New: ${names.new}. Every value is derived from the two records.`,
    '',
    `Identity cross-check (contract section 8 item 4): **${identity.pass ? 'PASS' : 'FAIL'}**${identity.pass ? '' : `, ${identity.differences.length} differences`}.`,
    '',
    `Verdict: old **${report.verdict.old}**, new **${report.verdict.new}**.`,
    '',
    '## Validity checks',
    '',
    ...report.checks.old.map((item) => `- old ${item}`),
    ...report.checks.new.map((item) => `- new ${item}`),
    '',
    '## Estimates',
    '',
    ...table(
      ['', 'old', 'new', 'new / old'],
      [
        pairRow('per path ns (supporting value)', report.estimates.perPathNs, 5),
        pairRow('T-hat initial ms', report.estimates.initialMs, 5),
        pairRow('t-hat edit p95 ms', report.estimates.editMs, 5),
        pairRow('M-hat mesh bytes', report.estimates.meshBytes, 5),
      ],
    ),
    '## Per-cell medians (ns per path, median over repetitions)',
    '',
    ...table(
      ['cell', 'batch old', 'batch new', 'batch new/old', 'path old', 'path new', 'path new/old'],
      report.cells.map((cell) => [
        cell.cell,
        format(cell.batchMedianNs.old, 5),
        format(cell.batchMedianNs.new, 5),
        format(cell.batchMedianNs.ratio, 4),
        format(cell.pathMedianNs.old, 5),
        format(cell.pathMedianNs.new, 5),
        format(cell.pathMedianNs.ratio, 4),
      ]),
    ),
    '## Fitted slopes and per-fit estimates',
    '',
    ...table(
      ['series', 'kind', 'rep', 'slope old', 'slope new', 'slope new/old', 'estimate ns new/old'],
      report.fits.map((fit) => [
        fit.series,
        fit.kind,
        String(fit.repetition),
        format(fit.slope.old, 5),
        format(fit.slope.new, 5),
        format(fit.slope.ratio, 4),
        format(fit.estimateNs.ratio, 4),
      ]),
    ),
    '## Stage split at the largest admitted cell (ns per 10-path batch)',
    '',
    ...table(
      ['series', 'cell', 'stage', 'old', 'new', 'new/old'],
      report.stages.flatMap((stage) =>
        ['flatten', 'topology', 'tessellation', 'total'].map((name) => [
          stage.series,
          stage.oldCell === stage.newCell ? stage.oldCell : `${stage.oldCell} / ${stage.newCell}`,
          name,
          format(stage[name].old, 5),
          format(stage[name].new, 5),
          format(stage[name].ratio, 4),
        ]),
      ),
    ),
    '## H1',
    '',
    report.h1Caveat,
    '',
    ...table(
      [
        'series',
        'exact share old',
        'exact share new',
        'overhead old',
        'overhead new',
        'verdict old',
        'verdict new',
      ],
      report.stages.map((stage) => [
        stage.series,
        format(stage.exactShare.old, 4),
        format(stage.exactShare.new, 4),
        format(stage.overhead.old, 4),
        format(stage.overhead.new, 4),
        stage.h1Verdict.old,
        String(stage.h1Verdict.new),
      ]),
    ),
  ];
  if (!identity.pass) {
    lines.push('## Identity differences', '');
    for (const item of identity.differences)
      lines.push(
        `- \`${item.field}\`: old \`${item.old.slice(0, 200)}\`, new \`${item.new.slice(0, 200)}\``,
      );
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** Returns true when the identity cross-check passes; the caller maps false to exit code 1. */
export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const oldRecord = loadRecord(path.resolve(options.old));
  const newRecord = loadRecord(path.resolve(options.new));
  const identity = identityCheck(oldRecord, newRecord);
  const report = compareRecords(oldRecord, newRecord);
  console.log(
    `Verdict: old ${report.verdict.old}, new ${report.verdict.new}. T-hat ratio ${format(report.estimates.initialMs.ratio)}, t-hat edit ratio ${format(report.estimates.editMs.ratio)}, M-hat ratio ${format(report.estimates.meshBytes.ratio)}.`,
  );
  if (identity.pass) console.log('Identity cross-check: PASS');
  else {
    console.error(`Identity cross-check: FAIL (${identity.differences.length} differences)`);
    for (const item of identity.differences)
      console.error(
        `  ${item.field}: old ${item.old.slice(0, 120)} / new ${item.new.slice(0, 120)}`,
      );
  }
  if (options.markdown !== null)
    writeFileSync(
      path.resolve(options.markdown),
      renderMarkdown(report, identity, {
        old: String(oldRecord.run.runId),
        new: String(newRecord.run.runId),
      }),
    );
  return identity.pass;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (pass) => {
      process.exitCode = pass ? 0 : 1;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
