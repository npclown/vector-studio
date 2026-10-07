import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  documentOf,
  evaluateCorpus,
  evaluateTrajectories,
  T02_CORPORA,
  type ReportRow,
} from '../geometry/extent-t02/report.js';

// P3.1p T02 report (docs/plans/p3-r2-tiling-contract.md, "Report and replay"). Sharded per
// corpus; P3_T02_WRITE=1 writes artifacts/p3.1p-t02/report.json, P3_T02_REPLAY=<file> replays it.

const ROOT = 'artifacts/p3.1p-t02';
const write = process.env.P3_T02_WRITE === '1';
const replay = process.env.P3_T02_REPLAY;
const json = (value: unknown) =>
  `${JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe.runIf(write)('P3.1p T02 report write', () => {
  for (const corpus of T02_CORPORA)
    it(`evaluates corpus ${corpus}`, () => {
      mkdirSync(path.join(ROOT, 'parts'), { recursive: true });
      const rows = evaluateCorpus(corpus);
      writeFileSync(path.join(ROOT, 'parts', `${corpus}.json`), json(rows));
      console.log(`T02 corpus ${corpus}: ${rows.length} records`);
    });
  it('evaluates trajectories', () => {
    const rows = evaluateTrajectories();
    writeFileSync(path.join(ROOT, 'parts', 'trajectories.json'), json(rows));
    console.log(`T02 trajectories: ${rows.length} records`);
  });
  it('assembles report.json', () => {
    const rows = T02_CORPORA.flatMap(
      (corpus) =>
        JSON.parse(readFileSync(path.join(ROOT, 'parts', `${corpus}.json`), 'utf8')) as ReportRow[],
    );
    const trajectories = JSON.parse(
      readFileSync(path.join(ROOT, 'parts', 'trajectories.json'), 'utf8'),
    ) as ReportRow[];
    const file = path.join(ROOT, 'report.json');
    if (existsSync(file)) throw new Error(`${file} already exists`);
    const text = json(documentOf(rows, trajectories));
    writeFileSync(file, text, { flag: 'wx' });
    console.log(`T02 report sha256=${createHash('sha256').update(text).digest('hex')}`);
  });
});

describe.runIf(replay !== undefined)('P3.1p T02 report replay', () => {
  const report = () =>
    JSON.parse(readFileSync(replay!, 'utf8')) as {
      rows: ReportRow[];
      trajectories: ReportRow[];
    };
  for (const corpus of T02_CORPORA)
    it(`replays corpus ${corpus} row by row`, () => {
      const archived = report().rows.filter((row) => row.corpus === corpus);
      const rows = JSON.parse(json(evaluateCorpus(corpus))) as ReportRow[];
      expect(rows.length).toBe(archived.length);
      rows.forEach((row, index) => {
        if (digest(row) !== digest(archived[index]))
          throw new Error(`first differing row: ${corpus}#${index} ${String(row.id)}`);
      });
    });
  it('replays trajectories and the whole document byte for byte', () => {
    const archived = report();
    const trajectories = JSON.parse(json(evaluateTrajectories())) as ReportRow[];
    expect(digest(trajectories)).toBe(digest(archived.trajectories));
    expect(json(documentOf(archived.rows, trajectories))).toBe(readFileSync(replay!, 'utf8'));
  });
});
