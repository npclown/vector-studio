/**
 * P3 Alt-A1 AL-OB5 unit OB5-U1 (`docs/plans/p3-al-ob5-workload-scenario-proposal.md` section 2.1):
 * the TypeScript corpus reproduces the committed path-bit fixture and the framed corpus
 * SHA-256. The fixture was produced by an independent Rust implementation of B0's generator
 * (`packages/geometry-wasm/kernel/src/p3_al_ob5_tests.rs`), so this check is not circular; the
 * native test checks the same file against that generator.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateCellPaths,
  scalarBits,
  VERB_CLOSE,
  VERB_CUBIC,
  VERB_MOVE,
} from './p3-b0/corpus.js';
import {
  encodeOb5DecisionCorpus,
  encodeOb5ObservationCorpus,
  ob5DecisionCells,
  ob5ExpectedCounts,
  ob5ObservationCells,
  OB5_CUBICS,
  OB5_PATHS,
} from './p3-al-ob5/corpus.js';

/** Framed decision corpus (three snapped sets), recorded in the plan with OB5-U1. */
const DECISION_CORPUS_SHA256 = '353fef77a5f7fe9208bdd6566a16477833ea0dc47528dbaca8581a37222acc2f';
/** Framed corpus of the unsnapped OB5-W8 observation set. */
const OBSERVATION_CORPUS_SHA256 =
  '8c6618bec379f5e1041ef5803913e16208427cbb178c784afa1238580b2596fc';

interface FixturePath {
  index: number;
  verbs: number[];
  bits: string[];
}
interface Fixture {
  scenario: string;
  sets: { id: string; paths: FixturePath[] }[];
}
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'p3-al-ob5/fixture.json'), 'utf8'),
) as Fixture;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('AL-OB5 workload corpus (OB5-U1)', () => {
  it('defines the three decision sets of section 2.1', () => {
    const cells = ob5DecisionCells();
    expect(cells.map(({ id, lambda, bulge }) => [id, lambda, bulge])).toEqual([
      ['OB5-W2', 2, 3 / 64],
      ['OB5-W4', 4, 3 / 16],
      ['OB5-W8', 8, 3 / 8],
    ]);
    for (const cell of cells) {
      expect(cell).toMatchObject({
        role: 'decision',
        family: 'ring',
        entry: 'attempt',
        contours: 1,
        cubicsPerContour: 32,
        snapped: true,
        paths: 1000,
      });
    }
    expect(ob5ExpectedCounts(2)).toEqual({ vertices: 64, triangles: 62, boundaryPairs: 64 });
    expect(ob5ExpectedCounts(4)).toEqual({ vertices: 128, triangles: 126, boundaryPairs: 128 });
    expect(ob5ExpectedCounts(8)).toEqual({ vertices: 256, triangles: 254, boundaryPairs: 256 });
  });

  it('keeps the unsnapped OB5-W8 observation out of the decision sets', () => {
    const [observation] = ob5ObservationCells();
    expect(observation).toMatchObject({ id: 'OB5-W8U', lambda: 8, snapped: false, paths: 1000 });
    expect(ob5DecisionCells().map(({ id }) => id)).not.toContain(observation!.id);
  });

  it('reproduces the first and last path bits of each set from the independent fixture', () => {
    expect(fixture.scenario).toBe('p3-al-ob5-workload/v1');
    expect(fixture.sets.map(({ id }) => id)).toEqual(ob5DecisionCells().map(({ id }) => id));
    for (const [position, cell] of ob5DecisionCells().entries()) {
      const generated = generateCellPaths(cell);
      expect(generated).toHaveLength(OB5_PATHS);
      const set = fixture.sets[position]!;
      expect(set.paths.map(({ index }) => index)).toEqual([0, OB5_PATHS - 1]);
      for (const entry of set.paths) {
        const actual = generated[entry.index]!;
        expect(actual.verbs, `${cell.id}[${entry.index}] verbs`).toEqual(entry.verbs);
        expect(scalarBits(actual.points), `${cell.id}[${entry.index}] bits`).toEqual(entry.bits);
      }
    }
  });

  it('shapes every path as one closed contour of 32 cubics', () => {
    for (const cell of [...ob5DecisionCells(), ...ob5ObservationCells()]) {
      for (const { verbs, points } of generateCellPaths(cell)) {
        expect(verbs).toHaveLength(OB5_CUBICS + 2);
        expect(verbs[0]).toBe(VERB_MOVE);
        expect(verbs.slice(1, -1).every((verb) => verb === VERB_CUBIC)).toBe(true);
        expect(verbs.at(-1)).toBe(VERB_CLOSE);
        expect(points).toHaveLength(2 + 6 * OB5_CUBICS);
        // The last cubic ends on the first vertex bit for bit.
        expect(points.slice(-2)).toEqual(points.slice(0, 2));
      }
    }
  });

  it('reproduces the framed corpus SHA-256 values', () => {
    expect(sha256(encodeOb5DecisionCorpus())).toBe(DECISION_CORPUS_SHA256);
    expect(sha256(encodeOb5ObservationCorpus())).toBe(OBSERVATION_CORPUS_SHA256);
  });
});
