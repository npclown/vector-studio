import type { ScenePathVerb } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  ARC_MESSAGE,
  MAX_COORDINATE,
  MAX_INPUT_LENGTH,
  MAX_VERBS,
  parsePathData,
  type PathDataErrorCode,
  type PathDataResult,
} from '../../apps/playground/src/viz-v2-path-data-parse.js';
import {
  INITIAL_APPEARANCE,
  pathSnapshot,
} from '../../apps/playground/src/viz-v2-path-data-state.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

// Visualization track V-2 (docs/plans/viz-v2-path-data-contract.md), acceptance criteria V2-A3 to
// V2-A7 (unit part): the grammar table, the error table, the seeded oracle comparison and round
// trip, the mapping and the limits. Functional evidence only: precision is UNVERIFIED.
//
// The oracle below is independent of the parser (contract section 2): it does not import the
// parser module and shares no code with it. The parser is a character scanner. The oracle
// tokenizes the whole input with sticky regular expressions and expands the commands from a table.
// The V2-A3 and V2-A4 tables are hand-written literals computed by neither implementation.

// ---------------------------------------------------------------------------------------------
// The independent oracle
// ---------------------------------------------------------------------------------------------

type OracleCode = PathDataErrorCode;
class OracleError extends Error {
  public constructor(
    public readonly code: OracleCode,
    public readonly offset: number,
  ) {
    super(code);
  }
}
type Elevated = {
  p0: readonly [number, number];
  q: readonly [number, number];
  p2: readonly [number, number];
  c1: readonly [number, number];
  c2: readonly [number, number];
};
type OracleResult =
  | { ok: true; verbs: ScenePathVerb[]; points: number[]; elevated: Elevated[] }
  | { ok: false; code: OracleCode; offset: number; line: number; column: number };

type Token = {
  kind: 'space' | 'comma' | 'command' | 'number' | 'badnumber' | 'other';
  text: string;
  /** Index of the token's first code unit. */
  start: number;
  /** The offset an error about this token reports (differs from `start` for a bad exponent). */
  at: number;
};

const RE_SPACE = /[\t\n\f\r ]+/y;
const RE_COMMA = /,/y;
const RE_COMMAND = /[MmZzLlHhVvCcSsQqTtAa]/y;
const RE_NUMBER = /[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const RE_NUMBERISH = /[-+.0-9]/y;

function sticky(pattern: RegExp, text: string, index: number): string | null {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match === null ? null : match[0];
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    let found: string | null;
    if ((found = sticky(RE_SPACE, text, index)) !== null) {
      tokens.push({ kind: 'space', text: found, start: index, at: index });
    } else if ((found = sticky(RE_COMMA, text, index)) !== null) {
      tokens.push({ kind: 'comma', text: found, start: index, at: index });
    } else if ((found = sticky(RE_COMMAND, text, index)) !== null) {
      tokens.push({ kind: 'command', text: found, start: index, at: index });
    } else if ((found = sticky(RE_NUMBER, text, index)) !== null) {
      const end = index + found.length;
      const hasExponent = /[eE]/.test(found);
      if (!hasExponent && /[eE]/.test(text[end] ?? '')) {
        // An `e` right after a mantissa commits to an exponent; no digit follows it.
        tokens.push({ kind: 'badnumber', text: found, start: index, at: end });
        index = end + 1;
        continue;
      }
      tokens.push({ kind: 'number', text: found, start: index, at: index });
    } else if (sticky(RE_NUMBERISH, text, index) !== null) {
      tokens.push({ kind: 'badnumber', text: text[index]!, start: index, at: index });
      found = text[index]!;
    } else {
      found = text[index]!;
      tokens.push({ kind: 'other', text: found, start: index, at: index });
    }
    index += found.length;
  }
  return tokens;
}

const ARGUMENTS: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
};

const plusZero = (value: number) => (Object.is(value, -0) ? 0 : value);

function oracleLineColumn(text: string, offset: number) {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

function oracle(text: string): OracleResult {
  try {
    return oracleRun(text);
  } catch (error) {
    if (!(error instanceof OracleError)) throw error;
    return {
      ok: false,
      code: error.code,
      offset: error.offset,
      ...oracleLineColumn(text, error.offset),
    };
  }
}

function oracleRun(text: string): OracleResult {
  if (text.length > 65_536) throw new OracleError('input-too-long', 65_536);
  const tokens = tokenize(text);
  let cursor = 0;
  const verbs: ScenePathVerb[] = [];
  const points: number[] = [];
  const elevated: Elevated[] = [];
  const skipSpace = () => {
    while (tokens[cursor]?.kind === 'space') cursor += 1;
  };

  skipSpace();
  const first = tokens[cursor];
  if (first === undefined) return { ok: true, verbs, points, elevated };
  if (first.kind !== 'command' || !/^[Mm]$/.test(first.text)) {
    throw new OracleError('missing-moveto', first.start);
  }

  let current: [number, number] = [0, 0];
  let subpathStart: [number, number] = [0, 0];
  let previousKind: 'cubic' | 'quad' | 'none' = 'none';
  let previousControl: [number, number] = [0, 0];
  let closedLast = false;

  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (token.kind !== 'command') throw new OracleError('unexpected-character', token.start);
    if (/^[Aa]$/.test(token.text)) throw new OracleError('unsupported-command', token.start);
    cursor += 1;
    const letter = token.text.toUpperCase();
    const relative = token.text !== letter;

    if (letter === 'Z') {
      const needed = closedLast ? 2 : 1;
      if (verbs.length + needed > 4_096) throw new OracleError('too-many-verbs', token.start);
      if (closedLast) {
        verbs.push('move');
        points.push(...subpathStart);
      }
      verbs.push('close');
      current = [...subpathStart];
      previousKind = 'none';
      closedLast = true;
      skipSpace();
      continue;
    }

    const count = ARGUMENTS[letter]!;
    skipSpace();
    if (tokens[cursor]?.kind === 'comma') {
      throw new OracleError('unexpected-character', tokens[cursor]!.start);
    }
    let group = 0;
    for (;;) {
      const values: number[] = [];
      let groupStart = -1;
      for (let slot = 0; slot < count; slot += 1) {
        if (slot > 0) {
          skipSpace();
          if (tokens[cursor]?.kind === 'comma') {
            cursor += 1;
            skipSpace();
          }
        }
        const t = tokens[cursor];
        if (t === undefined) throw new OracleError('expected-number', text.length);
        if (t.kind === 'command') throw new OracleError('expected-number', t.start);
        if (t.kind === 'badnumber') throw new OracleError('invalid-number', t.at);
        if (t.kind !== 'number') throw new OracleError('unexpected-character', t.start);
        cursor += 1;
        if (slot === 0) groupStart = t.start;
        const value = Number(t.text);
        if (!Number.isFinite(value)) throw new OracleError('coordinate-out-of-range', groupStart);
        values.push(value);
      }

      // Map the group. `abs` turns a pair of arguments into an absolute point.
      const abs = (index: number): [number, number] =>
        relative
          ? [current[0] + values[index]!, current[1] + values[index + 1]!]
          : [values[index]!, values[index + 1]!];
      const limit = (...pairs: Array<readonly [number, number]>) => {
        for (const pair of pairs) {
          for (const v of pair) {
            if (!Number.isFinite(v) || Math.abs(v) > 2 ** 24) {
              throw new OracleError('coordinate-out-of-range', groupStart);
            }
          }
        }
      };
      let emitted: ScenePathVerb[];
      let emittedPoints: Array<readonly [number, number]>;
      let end: [number, number];
      let nextKind: 'cubic' | 'quad' | 'none' = 'none';
      let nextControl: [number, number] = previousControl;
      let elevatedNow: Elevated | null = null;
      let newStart: [number, number] | null = null;
      const reflect = (): [number, number] => [
        2 * current[0] - previousControl[0],
        2 * current[1] - previousControl[1],
      ];
      switch (letter) {
        case 'M': {
          const point = abs(0);
          limit(point);
          emitted = [group === 0 ? 'move' : 'line'];
          emittedPoints = [point];
          end = point;
          if (group === 0) newStart = point;
          break;
        }
        case 'L': {
          const point = abs(0);
          limit(point);
          emitted = ['line'];
          emittedPoints = [point];
          end = point;
          break;
        }
        case 'H': {
          const x = relative ? current[0] + values[0]! : values[0]!;
          limit([x, current[1]]);
          emitted = ['line'];
          emittedPoints = [[x, current[1]]];
          end = [x, current[1]];
          break;
        }
        case 'V': {
          const y = relative ? current[1] + values[0]! : values[0]!;
          limit([current[0], y]);
          emitted = ['line'];
          emittedPoints = [[current[0], y]];
          end = [current[0], y];
          break;
        }
        case 'C': {
          const c1 = abs(0);
          const c2 = abs(2);
          const e = abs(4);
          limit(c1, c2, e);
          emitted = ['cubic'];
          emittedPoints = [c1, c2, e];
          end = e;
          nextKind = 'cubic';
          nextControl = [plusZero(c2[0]), plusZero(c2[1])];
          break;
        }
        case 'S': {
          const c2 = abs(0);
          const e = abs(2);
          const r: [number, number] = previousKind === 'cubic' ? reflect() : [...current];
          limit(r, c2, e);
          emitted = ['cubic'];
          emittedPoints = [r, c2, e];
          end = e;
          nextKind = 'cubic';
          nextControl = [plusZero(c2[0]), plusZero(c2[1])];
          break;
        }
        default: {
          // Q and T
          let q: [number, number];
          let e: [number, number];
          if (letter === 'Q') {
            q = abs(0);
            e = abs(2);
          } else {
            q = previousKind === 'quad' ? reflect() : [...current];
            e = abs(0);
          }
          const c1: [number, number] = [(current[0] + 2 * q[0]) / 3, (current[1] + 2 * q[1]) / 3];
          const c2: [number, number] = [(e[0] + 2 * q[0]) / 3, (e[1] + 2 * q[1]) / 3];
          limit(q, e, c1, c2);
          emitted = ['cubic'];
          emittedPoints = [c1, c2, e];
          end = e;
          nextKind = 'quad';
          nextControl = [plusZero(q[0]), plusZero(q[1])];
          elevatedNow = {
            p0: [current[0], current[1]],
            q: [plusZero(q[0]), plusZero(q[1])],
            p2: [plusZero(e[0]), plusZero(e[1])],
            c1: [plusZero(c1[0]), plusZero(c1[1])],
            c2: [plusZero(c2[0]), plusZero(c2[1])],
          };
        }
      }

      const implicitMove = closedLast && letter !== 'M' && group === 0;
      if (verbs.length + emitted.length + (implicitMove ? 1 : 0) > 4_096) {
        throw new OracleError('too-many-verbs', groupStart);
      }
      if (implicitMove) {
        verbs.push('move');
        points.push(...subpathStart);
      }
      verbs.push(...emitted);
      for (const pair of emittedPoints) points.push(plusZero(pair[0]), plusZero(pair[1]));
      current = [plusZero(end[0]), plusZero(end[1])];
      if (newStart !== null) subpathStart = [plusZero(newStart[0]), plusZero(newStart[1])];
      previousKind = nextKind;
      previousControl = nextControl;
      closedLast = false;
      if (elevatedNow !== null) elevated.push(elevatedNow);
      group += 1;

      // After a group: the end, an implicit repeat, or the next command.
      skipSpace();
      const next = tokens[cursor];
      if (next === undefined) break;
      if (next.kind === 'comma') {
        let after = cursor + 1;
        while (tokens[after]?.kind === 'space') after += 1;
        const target = tokens[after];
        if (target?.kind === 'number' || target?.kind === 'badnumber') {
          cursor = after;
          continue;
        }
        throw new OracleError('unexpected-character', next.start);
      }
      if (next.kind === 'number' || next.kind === 'badnumber') continue;
      break;
    }
  }
  return { ok: true, verbs, points, elevated };
}

/** Canonical absolute text of a mapped path, for the round trip (V2-A5). */
function serialize(verbs: readonly ScenePathVerb[], points: readonly number[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const verb of verbs) {
    if (verb === 'move' || verb === 'line') {
      parts.push(
        `${verb === 'move' ? 'M' : 'L'} ${String(points[at]!)} ${String(points[at + 1]!)}`,
      );
      at += 2;
    } else if (verb === 'cubic') {
      parts.push(
        `C ${points
          .slice(at, at + 6)
          .map(String)
          .join(' ')}`,
      );
      at += 6;
    } else parts.push('Z');
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function sameBits(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

const okOf = (result: PathDataResult) => {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
};

// ---------------------------------------------------------------------------------------------
// V2-A3: the grammar table. Expected verbs and points are hand-written literals.
// ---------------------------------------------------------------------------------------------

type Row = readonly [name: string, input: string, verbs: string[], points: number[]];
const M = 'move';
const L = 'line';
const C = 'cubic';
const Z = 'close';

const GRAMMAR_ROWS: readonly Row[] = [
  ['M', 'M 10 20', [M], [10, 20]],
  ['m first is absolute', 'm 10 20', [M], [10, 20]],
  ['m -0 -0 first', 'm -0 -0', [M], [0, 0]],
  ['L', 'M 1 2 L 3 4', [M, L], [1, 2, 3, 4]],
  ['l', 'M 1 2 l 3 4', [M, L], [1, 2, 4, 6]],
  ['H', 'M 1 2 H 5', [M, L], [1, 2, 5, 2]],
  ['h', 'M 1 2 h 5', [M, L], [1, 2, 6, 2]],
  ['V', 'M 1 2 V 5', [M, L], [1, 2, 1, 5]],
  ['v', 'M 1 2 v 5', [M, L], [1, 2, 1, 7]],
  ['C', 'M 0 0 C 1 2 3 4 5 6', [M, C], [0, 0, 1, 2, 3, 4, 5, 6]],
  ['c', 'M 1 1 c 1 2 3 4 5 6', [M, C], [1, 1, 2, 3, 4, 5, 6, 7]],
  [
    'S after C reflects',
    'M 0 0 C 1 2 3 4 5 6 S 11 12 13 14',
    [M, C, C],
    [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14],
  ],
  [
    's after C, relative',
    'M 0 0 C 1 2 3 4 5 6 s 1 1 2 2',
    [M, C, C],
    [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 6, 7, 7, 8],
  ],
  ['S after S', 'M 0 0 S 1 1 2 2 S 3 3 4 4', [M, C, C], [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4]],
  [
    'S after L uses the current point',
    'M 1 1 L 2 2 S 3 3 4 4',
    [M, L, C],
    [1, 1, 2, 2, 2, 2, 3, 3, 4, 4],
  ],
  [
    'S after Q uses the current point',
    'M 0 0 Q 3 3 6 0 S 7 7 8 8',
    [M, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 6, 0, 7, 7, 8, 8],
  ],
  [
    'implicit S repeat',
    'M 0 0 S 1 1 2 2 3 3 4 4',
    [M, C, C],
    [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4],
  ],
  ['implicit s', 'M 0 0 s 1 1 2 2 1 1 2 2', [M, C, C], [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4]],
  [
    'implicit t',
    'M 0 0 Q 3 3 6 0 t 6 0 6 0',
    [M, C, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 8, -2, 10, -2, 12, 0, 14, 2, 16, 2, 18, 0],
  ],
  ['Q elevation', 'M 0 0 Q 3 3 6 0', [M, C], [0, 0, 2, 2, 4, 2, 6, 0]],
  ['q elevation', 'M 0 0 q 3 3 6 0', [M, C], [0, 0, 2, 2, 4, 2, 6, 0]],
  [
    'T after Q reflects',
    'M 0 0 Q 3 3 6 0 T 12 0',
    [M, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 8, -2, 10, -2, 12, 0],
  ],
  [
    'T after T',
    'M 0 0 Q 3 3 6 0 T 12 0 T 18 0',
    [M, C, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 8, -2, 10, -2, 12, 0, 14, 2, 16, 2, 18, 0],
  ],
  [
    't after Q, relative',
    'M 0 0 Q 3 3 6 0 t 6 0',
    [M, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 8, -2, 10, -2, 12, 0],
  ],
  [
    'T after L uses the current point',
    'M 0 0 L 6 0 T 12 0',
    [M, L, C],
    [0, 0, 6, 0, 6, 0, 8, 0, 12, 0],
  ],
  [
    'T after C uses the current point',
    'M 0 0 C 0 0 0 0 6 0 T 12 0',
    [M, C, C],
    [0, 0, 0, 0, 0, 0, 6, 0, 6, 0, 8, 0, 12, 0],
  ],
  ['implicit L after M', 'M 1 2 3 4 5 6', [M, L, L], [1, 2, 3, 4, 5, 6]],
  ['implicit l after m', 'm 1 2 3 4', [M, L], [1, 2, 4, 6]],
  ['implicit L', 'M 0 0 L 1 1 2 2', [M, L, L], [0, 0, 1, 1, 2, 2]],
  ['implicit l', 'M 0 0 l 1 1 2 2', [M, L, L], [0, 0, 1, 1, 3, 3]],
  ['implicit H', 'M 0 0 H 1 2 3', [M, L, L, L], [0, 0, 1, 0, 2, 0, 3, 0]],
  ['implicit h', 'M 0 0 h 1 2 3', [M, L, L, L], [0, 0, 1, 0, 3, 0, 6, 0]],
  ['implicit V', 'M 0 0 V 1 2', [M, L, L], [0, 0, 0, 1, 0, 2]],
  ['implicit v', 'M 0 0 v 1 2', [M, L, L], [0, 0, 0, 1, 0, 3]],
  [
    'implicit C',
    'M 0 0 C 1 1 2 2 3 3 4 4 5 5 6 6',
    [M, C, C],
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6],
  ],
  [
    'implicit c',
    'M 0 0 c 1 1 2 2 3 3 1 1 2 2 3 3',
    [M, C, C],
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6],
  ],
  [
    'implicit Q',
    'M 0 0 Q 3 3 6 0 9 3 12 0',
    [M, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 8, 2, 10, 2, 12, 0],
  ],
  [
    'implicit q',
    'M 0 0 q 3 3 6 0 3 3 6 0',
    [M, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 8, 2, 10, 2, 12, 0],
  ],
  [
    'implicit T',
    'M 0 0 Q 3 3 6 0 T 12 0 18 0',
    [M, C, C, C],
    [0, 0, 2, 2, 4, 2, 6, 0, 8, -2, 10, -2, 12, 0, 14, 2, 16, 2, 18, 0],
  ],
  ['Z', 'M 0 0 L 4 0 L 4 4 Z', [M, L, L, Z], [0, 0, 4, 0, 4, 4]],
  ['z', 'M 0 0 L 4 0 L 4 4 z', [M, L, L, Z], [0, 0, 4, 0, 4, 4]],
  ['Z only', 'M 3 3 Z', [M, Z], [3, 3]],
  [
    'L after Z: implicit move to the subpath start',
    'M 1 1 L 5 1 Z L 5 5',
    [M, L, Z, M, L],
    [1, 1, 5, 1, 1, 1, 5, 5],
  ],
  ['H after Z', 'M 1 1 Z H 4', [M, Z, M, L], [1, 1, 1, 1, 4, 1]],
  [
    'C after Z',
    'M 1 1 L 2 2 Z C 3 3 4 4 5 5',
    [M, L, Z, M, C],
    [1, 1, 2, 2, 1, 1, 3, 3, 4, 4, 5, 5],
  ],
  [
    'm after Z is relative to the subpath start',
    'M 1 1 L 5 1 Z m 2 2',
    [M, L, Z, M],
    [1, 1, 5, 1, 3, 3],
  ],
  ['M after Z', 'M 1 1 Z M 2 2', [M, Z, M], [1, 1, 2, 2]],
  ['Z Z', 'M 1 1 L 3 3 Z Z', [M, L, Z, M, Z], [1, 1, 3, 3, 1, 1]],
  ['M M', 'M 1 1 M 2 2', [M, M], [1, 1, 2, 2]],
  ['space then tab', 'M\t1\t2', [M], [1, 2]],
  ['LF', 'M\n1\n2', [M], [1, 2]],
  ['FF', 'M\f1\f2', [M], [1, 2]],
  ['CR', 'M\r1\r2', [M], [1, 2]],
  ['no whitespace', 'M1 2L3 4', [M, L], [1, 2, 3, 4]],
  ['comma pairs', 'M 1,2 L 3,4', [M, L], [1, 2, 3, 4]],
  ['comma with spaces', 'M 1 , 2', [M], [1, 2]],
  ['comma between pairs', 'M 1 2 , 3 4', [M, L], [1, 2, 3, 4]],
  ['comma only', 'M1,2,3,4', [M, L], [1, 2, 3, 4]],
  ['comma then space', 'M 1, 2', [M], [1, 2]],
  ['leading and trailing whitespace', ' \t\n M 1 2 \n\t ', [M], [1, 2]],
  ['compact 1-2', 'M 1-2', [M], [1, -2]],
  ['compact 0.5.5', 'M 0.5.5', [M], [0.5, 0.5]],
  ['.5 and 5.', 'M .5 5.', [M], [0.5, 5]],
  ['+.5', 'M +.5 +1', [M], [0.5, 1]],
  ['exponents', 'M 1e-2 1E+2', [M], [0.01, 100]],
  ['leading zeros', 'M 007 -008', [M], [7, -8]],
  ['compact run', 'M1-2-3-4', [M, L], [1, -2, -3, -4]],
  ['-0 is stored as +0', 'M -0 -0', [M], [0, 0]],
  ['-0 in a line', 'M 5 5 L -0 -0', [M, L], [5, 5, 0, 0]],
  ['underflow to -0 is +0', 'M -1e-400 0', [M], [0, 0]],
  [
    'elevation underflow to -0 is +0',
    'M -5e-324 0 Q 0 0 0 0',
    [M, C],
    [-5e-324, 0, 0, 0, 0, 0, 0, 0],
  ],
  ['empty', '', [], []],
  ['whitespace only', ' \t\n\f\r ', [], []],
];

describe('V2-A3 grammar table', () => {
  for (const [name, input, verbs, points] of GRAMMAR_ROWS) {
    it(name, () => {
      const result = okOf(parsePathData(input));
      expect(result.verbs).toEqual(verbs);
      expect(sameBits(result.points, points), `${JSON.stringify(result.points)}`).toBe(true);
      // The independent oracle agrees with the literal.
      const expected = oracle(input);
      expect(expected.ok).toBe(true);
      if (expected.ok) {
        expect(expected.verbs).toEqual(verbs);
        expect(sameBits(expected.points, points)).toBe(true);
      }
    });
  }

  it('maps an empty path to zero verbs and zero points', () => {
    const result = okOf(parsePathData(''));
    expect(result.verbs).toHaveLength(0);
    expect(result.points).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// V2-A4: the error table. Each row is { code, offset, line, column }.
// ---------------------------------------------------------------------------------------------

type ErrorRow = readonly [
  name: string,
  input: string,
  code: PathDataErrorCode,
  offset: number,
  line: number,
  column: number,
];

const longTail = (total: number) => 'M 0 0' + ' '.repeat(total - 5);

const ERROR_ROWS: readonly ErrorRow[] = [
  ['first L', 'L 1 1', 'missing-moveto', 0, 1, 1],
  ['first L after whitespace', '  L 1 1', 'missing-moveto', 2, 1, 3],
  ['first a', 'a 1 1 0 0 1 2 2', 'missing-moveto', 0, 1, 1],
  ['first A', 'A 1 1 0 0 1 2 2', 'missing-moveto', 0, 1, 1],
  ['first digit', '5 5', 'missing-moveto', 0, 1, 1],
  ['first comma', ', M 1 1', 'missing-moveto', 0, 1, 1],
  ['A after a group', 'M 0 0 A 1 1 0 0 1 2 2', 'unsupported-command', 6, 1, 7],
  ['a after a group', 'M 0 0 a 1 1 0 0 1 2 2', 'unsupported-command', 6, 1, 7],
  ['A after Z', 'M 0 0 Z A', 'unsupported-command', 8, 1, 9],
  ['a at the end', 'M 0 0 a', 'unsupported-command', 6, 1, 7],
  ['unknown letter', 'M 0 0 X', 'unexpected-character', 6, 1, 7],
  ['unknown letter e', 'M 0 0 e', 'unexpected-character', 6, 1, 7],
  ['A where a number is required', 'M 10 A', 'expected-number', 5, 1, 6],
  ['a where a number is required', 'M 10 a', 'expected-number', 5, 1, 6],
  ['comma after a command letter', 'M, 1 1', 'unexpected-character', 1, 1, 2],
  ['comma after a later letter', 'M 1 1 L, 2 2', 'unexpected-character', 7, 1, 8],
  ['doubled comma', 'M 1,,2', 'unexpected-character', 4, 1, 5],
  ['comma then command letter L', 'M 10 10, L 1 1', 'unexpected-character', 7, 1, 8],
  ['comma then command letter A', 'M 10 10, A', 'unexpected-character', 7, 1, 8],
  ['comma then X', 'M 10 10, X', 'unexpected-character', 7, 1, 8],
  ['comma then comma', 'M 10 10, ,', 'unexpected-character', 7, 1, 8],
  ['comma at the end', 'M 10 10,', 'unexpected-character', 7, 1, 8],
  ['comma before Z', 'M 0 0, Z', 'unexpected-character', 5, 1, 6],
  ['comma inside an incomplete group', 'M 10, L', 'expected-number', 6, 1, 7],
  ['number after Z', 'M 0 0 Z 5', 'unexpected-character', 8, 1, 9],
  ['comma after Z', 'M 0 0 Z,', 'unexpected-character', 7, 1, 8],
  ['U+00A0', 'M 1 1', 'unexpected-character', 1, 1, 2],
  ['U+00A0 after a group', 'M 1 1 L 2 2', 'unexpected-character', 5, 1, 6],
  ['missing coordinate at the end', 'M 1', 'expected-number', 3, 1, 4],
  ['missing coordinate before a letter', 'M 1 L 2 2', 'expected-number', 4, 1, 5],
  ['M and nothing', 'M', 'expected-number', 1, 1, 2],
  ['odd implicit repeat', 'M 1 2 3', 'expected-number', 7, 1, 8],
  ['bare minus', 'M -', 'invalid-number', 2, 1, 3],
  ['bare dot', 'M .', 'invalid-number', 2, 1, 3],
  ['plus dot', 'M +.', 'invalid-number', 2, 1, 3],
  ['bare minus second number', 'M 1 -', 'invalid-number', 4, 1, 5],
  ['exponent without digits', 'M 1e 2', 'invalid-number', 3, 1, 4],
  ['exponent sign without digits', 'M 1e+ 2', 'invalid-number', 3, 1, 4],
  ['capital exponent without digits', 'M 1.5E 2', 'invalid-number', 5, 1, 6],
  ['non-finite token', 'M 1e400 0', 'coordinate-out-of-range', 2, 1, 3],
  ['non-finite later group', 'M 0 0 L 1 1 -1e999 0', 'coordinate-out-of-range', 12, 1, 13],
  ['astral character', 'M 0 0 \u{1f600}', 'unexpected-character', 6, 1, 7],
  ['letter e after a group', 'M 1 1 e', 'unexpected-character', 6, 1, 7],
  ['multi-line, LF', 'M 0 0\nL 1 1\nX', 'unexpected-character', 12, 3, 1],
  ['multi-line, LF, indented', 'M 0 0\nL 1 1\n  X', 'unexpected-character', 14, 3, 3],
  ['multi-line, CR LF', 'M 0 0\r\nL 1 1\r\n  X', 'unexpected-character', 16, 3, 3],
  ['multi-line, lone CR', 'M 0 0\rL 1 1\r  X', 'unexpected-character', 14, 3, 3],
  ['blank lines', 'M 0 0\n\n\n  Q', 'expected-number', 11, 4, 4],
  ['coordinate just past 2^24', `M ${2 ** 24 + 2 ** -28} 0`, 'coordinate-out-of-range', 2, 1, 3],
  ['coordinate 2^24 + 1', 'M 16777217 0', 'coordinate-out-of-range', 2, 1, 3],
  ['negative coordinate past -2^24', 'M 0 -16777217', 'coordinate-out-of-range', 2, 1, 3],
  ['relative sum past 2^24', 'M 16777216 0 l 1 0', 'coordinate-out-of-range', 15, 1, 16],
  [
    'reflected point past 2^24',
    'M 0 0 C 0 0 0 0 16777216 0 S 1 1 2 2',
    'coordinate-out-of-range',
    29,
    1,
    30,
  ],
  ['H past 2^24', 'M 16777216 0 h 1', 'coordinate-out-of-range', 15, 1, 16],
  ['input one past the limit', longTail(65_537), 'input-too-long', 65_536, 1, 65_537],
  ['input far past the limit', 'x'.repeat(70_000), 'input-too-long', 65_536, 1, 65_537],
];

describe('V2-A4 error table', () => {
  for (const [name, input, code, offset, line, column] of ERROR_ROWS) {
    it(name, () => {
      const result = parsePathData(input);
      expect(result.status).toBe('error');
      if (result.status !== 'error') return;
      expect({
        code: result.code,
        offset: result.offset,
        line: result.line,
        column: result.column,
      }).toEqual({
        code,
        offset,
        line,
        column,
      });
      expect(result.message.length).toBeGreaterThan(0);
      // An error result carries no verbs or points.
      expect('verbs' in result).toBe(false);
      expect('points' in result).toBe(false);
      const expected = oracle(input);
      expect(expected.ok).toBe(false);
      if (!expected.ok) {
        expect({
          code: expected.code,
          offset: expected.offset,
          line: expected.line,
          column: expected.column,
        }).toEqual({
          code,
          offset,
          line,
          column,
        });
      }
    });
  }

  it('reports the arc message for A and a', () => {
    for (const input of ['M 0 0 A 1', 'M 0 0 a 1']) {
      const result = parsePathData(input);
      expect(result.status === 'error' && result.message).toBe(
        'Arc commands (A/a) are not supported on this page. Convert arcs to curves first.',
      );
    }
    expect(ARC_MESSAGE).toContain('Arc commands (A/a)');
  });

  it('names the offending character or token in the message where one exists', () => {
    const unknown = parsePathData('M 0 0 X');
    expect(unknown.status === 'error' && unknown.message).toContain("'X'");
    const astral = parsePathData('M 0 0 \u{1f600}');
    expect(astral.status === 'error' && astral.message).toContain('\u{1f600}');
    const bad = parsePathData('M 1e 2');
    expect(bad.status === 'error' && bad.message).toContain('1e');
  });

  it('parsing is deterministic and leaves no state between calls', () => {
    const first = parsePathData('M 0 0 L 1 1');
    parsePathData('M 0 0 L');
    const second = parsePathData('M 0 0 L 1 1');
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------------------------
// V2-A5: seeded generator, oracle comparison, mutations, round trip
// ---------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const int = (rand: Rand, min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

function numberText(rand: Rand): string {
  const sign = pick(rand, ['', '', '-', '+']);
  const digits = (count: number) =>
    Array.from({ length: count }, () => String(int(rand, 0, 9))).join('');
  switch (int(rand, 0, 7)) {
    case 0:
      return `${sign}${int(rand, 0, 999)}`;
    case 1:
      return `${sign}${int(rand, 0, 99)}.${digits(int(rand, 0, 4))}`;
    case 2:
      return `${sign}.${digits(int(rand, 1, 4))}`;
    case 3:
      return `${sign}${int(rand, 0, 99)}${pick(rand, ['e', 'E'])}${pick(rand, ['', '+', '-'])}${int(rand, 0, 3)}`;
    case 4:
      return `${sign}${int(rand, 0, 9)}.${digits(int(rand, 1, 3))}${pick(rand, ['e', 'E'])}${pick(rand, ['', '-'])}${int(rand, 0, 2)}`;
    case 5:
      return pick(rand, ['0', '-0', '+0', '007', '0.0', '-0.0', '.0']);
    case 6:
      return `${sign}${digits(int(rand, 1, 3))}`;
    default:
      return `${sign}${int(rand, 0, 500)}.${digits(int(rand, 1, 2))}`;
  }
}

const SEPARATORS = [' ', ' ', ',', ' , ', ', ', '\n', '\t', '  ', ' \n ', '\f', '\r\n', ' ,'];

function generate(rand: Rand): string {
  const letters = 'MmLlHhVvCcSsQqTtZz';
  const sizes: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };
  let text = pick(rand, ['', ' ', '\n', ' \t']);
  const commands = int(rand, 1, 8);
  for (let command = 0; command < commands; command += 1) {
    const letter =
      command === 0 ? pick(rand, ['M', 'm']) : letters[int(rand, 0, letters.length - 1)]!;
    text += letter;
    const size = sizes[letter.toUpperCase()]!;
    if (size === 0) {
      text += pick(rand, ['', ' ', ' ']);
      continue;
    }
    const groups = int(rand, 1, 3);
    let first = true;
    for (let group = 0; group < groups; group += 1) {
      for (let slot = 0; slot < size; slot += 1) {
        const value = numberText(rand);
        if (first) text += pick(rand, ['', ' ', ' ', '\n']);
        else {
          // An omitted separator is safe only before a sign.
          const omit = (value.startsWith('-') || value.startsWith('+')) && rand() < 0.4;
          text += omit ? '' : pick(rand, SEPARATORS);
        }
        text += value;
        first = false;
      }
    }
    text += pick(rand, ['', ' ', ' ', '\n']);
  }
  return text + pick(rand, ['', ' ', '\n']);
}

const MUTATION_CHARS = [...'0123456789.e+-, \t\n\fMmLlHhVvCcSsQqTtZzAaXx', 'é', ' '];

function mutate(rand: Rand, text: string): string {
  const offset = int(rand, 0, text.length);
  const char = pick(rand, MUTATION_CHARS);
  switch (int(rand, 0, 2)) {
    case 0:
      return text.slice(0, offset) + char + text.slice(offset);
    case 1:
      return text.slice(0, offset) + text.slice(offset + 1);
    default:
      return text.slice(0, offset) + char + text.slice(offset + 1);
  }
}

function compare(text: string): 'ok' | 'error' {
  const actual = parsePathData(text);
  const expected = oracle(text);
  if (actual.status === 'ok') {
    if (!expected.ok)
      throw new Error(
        `parser ok, oracle ${expected.code}@${expected.offset}: ${JSON.stringify(text)}`,
      );
    expect(actual.verbs, JSON.stringify(text)).toEqual(expected.verbs);
    if (!sameBits(actual.points, expected.points)) {
      throw new Error(`points differ for ${JSON.stringify(text)}`);
    }
    return 'ok';
  }
  if (expected.ok) {
    throw new Error(`parser ${actual.code}@${actual.offset}, oracle ok: ${JSON.stringify(text)}`);
  }
  expect(
    { code: actual.code, offset: actual.offset, line: actual.line, column: actual.column },
    JSON.stringify(text),
  ).toEqual({
    code: expected.code,
    offset: expected.offset,
    line: expected.line,
    column: expected.column,
  });
  return 'error';
}

describe('V2-A5 oracle comparison and round trip', () => {
  it('matches the oracle bit for bit on 3,000 seeded valid texts, and the canonical text round-trips', () => {
    const rand = seeded(0x5eed0001);
    let valid = 0;
    for (let index = 0; index < 3_000; index += 1) {
      const text = generate(rand);
      const actual = parsePathData(text);
      expect(actual.status, JSON.stringify(text)).toBe('ok');
      expect(compare(text)).toBe('ok');
      if (actual.status !== 'ok') continue;
      valid += 1;
      // No -0 is ever stored, so String(n) round-trips every value (contract section 1.2).
      expect(actual.points.some((value) => Object.is(value, -0))).toBe(false);
      const again = okOf(parsePathData(serialize(actual.verbs, actual.points)));
      expect(again.verbs).toEqual(actual.verbs);
      expect(sameBits(again.points, actual.points), JSON.stringify(text)).toBe(true);
    }
    expect(valid).toBe(3_000);
  });

  it('agrees with the oracle on 3,000 seeded one-character mutations', () => {
    const rand = seeded(0x5eed0002);
    let errors = 0;
    let oks = 0;
    for (let index = 0; index < 3_000; index += 1) {
      const base = generate(rand);
      const mutated = mutate(rand, base);
      if (compare(mutated) === 'error') errors += 1;
      else oks += 1;
    }
    // Both outcomes occur, so the comparison exercises accepted and rejected texts.
    expect(errors).toBeGreaterThan(300);
    expect(oks).toBeGreaterThan(300);
  });

  it('covers every error code in the mutation set at least once', () => {
    const rand = seeded(0x5eed0003);
    const seen = new Set<string>();
    for (let index = 0; index < 20_000 && seen.size < 6; index += 1) {
      const result = parsePathData(mutate(rand, generate(rand)));
      if (result.status === 'error') seen.add(result.code);
    }
    for (const code of [
      'missing-moveto',
      'unsupported-command',
      'unexpected-character',
      'expected-number',
      'invalid-number',
    ]) {
      expect(seen.has(code), code).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// V2-A6: the mapping
// ---------------------------------------------------------------------------------------------

/** The exact value of a binary64 number times 2^1100, as a BigInt (all doubles are multiples). */
function scaled(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
  const shift = BigInt((exponent === 0 ? 1 : exponent) + 25);
  const magnitude = mantissa << shift;
  return negative ? -magnitude : magnitude;
}
const absBig = (v: bigint) => (v < 0n ? -v : v);

/** Deviation bound of section 1.3, checked exactly: |c - (a + 2q) / 3| <= (|a| + 2|q|) / 3 (2u + u^2). */
function withinElevationBound(a: number, q: number, c: number): boolean {
  const deviation = absBig(3n * scaled(c) - (scaled(a) + 2n * scaled(q)));
  const magnitude = absBig(scaled(a)) + 2n * absBig(scaled(q));
  // 2u + u^2 with u = 2^-53 is (2^54 + 1) * 2^-106.
  return deviation << 106n <= magnitude * ((1n << 54n) + 1n);
}

describe('V2-A6 mapping', () => {
  it('maps H and V keeping the other coordinate, and reflections as 2 * p - c', () => {
    const h = okOf(parsePathData('M 1.5 2.25 H 9 V 7'));
    expect(h.points).toEqual([1.5, 2.25, 9, 2.25, 9, 7]);
    const reflected = okOf(parsePathData('M 0 0 C 1 2 3 4 5.5 6.5 S 11 12 13 14'));
    expect(reflected.points.slice(8, 14)).toEqual([2 * 5.5 - 3, 2 * 6.5 - 4, 11, 12, 13, 14]);
  });

  it('elevates Q to a cubic with the binary64 formula, bit for bit', () => {
    const rand = seeded(0x5eed0004);
    for (let index = 0; index < 500; index += 1) {
      const p0: [number, number] = [int(rand, -1000, 1000) / 7, int(rand, -1000, 1000) / 9];
      const q: [number, number] = [int(rand, -1000, 1000) / 3, int(rand, -1000, 1000) / 11];
      const p2: [number, number] = [int(rand, -1000, 1000) / 13, int(rand, -1000, 1000) / 17];
      const text = `M ${p0[0]} ${p0[1]} Q ${q[0]} ${q[1]} ${p2[0]} ${p2[1]}`;
      const result = okOf(parsePathData(text));
      const expected = [
        p0[0],
        p0[1],
        (p0[0] + 2 * q[0]) / 3,
        (p0[1] + 2 * q[1]) / 3,
        (p2[0] + 2 * q[0]) / 3,
        (p2[1] + 2 * q[1]) / 3,
        p2[0],
        p2[1],
      ].map((value) => (value === 0 ? 0 : value));
      expect(sameBits(result.points, expected), text).toBe(true);
    }
  });

  it('elevation of p0 (0,0), q (3,3), p2 (6,0) is exact: (2,2) and (4,2)', () => {
    const result = okOf(parsePathData('M 0 0 Q 3 3 6 0'));
    expect(result.points).toEqual([0, 0, 2, 2, 4, 2, 6, 0]);
    // The cubic equals the quadratic at t = k/4, in exact integer arithmetic scaled by 64.
    const [p0, c1, c2, p2] = [
      [0n, 0n],
      [2n, 2n],
      [4n, 2n],
      [6n, 0n],
    ] as const;
    const q = [3n, 3n] as const;
    for (let k = 0n; k <= 4n; k += 1n) {
      const m = 4n - k;
      for (const axis of [0, 1] as const) {
        const cubic =
          m ** 3n * p0[axis] +
          3n * m ** 2n * k * c1[axis] +
          3n * m * k ** 2n * c2[axis] +
          k ** 3n * p2[axis];
        const quadratic = 4n * (m ** 2n * p0[axis] + 2n * m * k * q[axis] + k ** 2n * p2[axis]);
        expect(cubic).toBe(quadratic);
      }
    }
  });

  it('keeps every elevated control inside the exact deviation bound (grammar rows and seeded cases)', () => {
    const texts = GRAMMAR_ROWS.map((row) => row[1]);
    const rand = seeded(0x5eed0001);
    for (let index = 0; index < 3_000; index += 1) texts.push(generate(rand));
    let checked = 0;
    for (const text of texts) {
      const expected = oracle(text);
      if (!expected.ok) continue;
      for (const e of expected.elevated) {
        // Subnormal results are excluded: the bound is relative, and underflow is absolute.
        if ([e.p0, e.q, e.p2].some((pair) => pair.some((v) => v !== 0 && Math.abs(v) < 1e-290)))
          continue;
        for (const axis of [0, 1] as const) {
          expect(withinElevationBound(e.p0[axis], e.q[axis], e.c1[axis]), text).toBe(true);
          expect(withinElevationBound(e.p2[axis], e.q[axis], e.c2[axis]), text).toBe(true);
          checked += 2;
        }
      }
    }
    expect(checked).toBeGreaterThan(2_000);
  });

  it('the exact bound check detects a wrong control point', () => {
    expect(withinElevationBound(0, 3, 2)).toBe(true);
    expect(withinElevationBound(0, 3, 2.0000001)).toBe(false);
  });

  it('every mapped result passes the scene grammar, and a mirror accepts the node of every grammar row', () => {
    const supported = {
      pathNodes: 'supported',
      pathFills: 'supported',
      pathStrokes: 'supported',
    } as const;
    for (const [name, input] of GRAMMAR_ROWS.map((row) => [row[0], row[1]] as const)) {
      const result = okOf(parsePathData(input));
      const pointCount = result.verbs.reduce(
        (sum, verb) => sum + (verb === 'cubic' ? 3 : verb === 'close' ? 0 : 1),
        0,
      );
      expect(result.points.length, name).toBe(pointCount * 2);
      expect(result.points.every(Number.isFinite), name).toBe(true);
      let open = false;
      for (const verb of result.verbs) {
        if (verb === 'move') open = true;
        else if (verb === 'close') {
          expect(open, name).toBe(true);
          open = false;
        } else expect(open, name).toBe(true);
      }
      const mirror = new RetainedSceneMirror(undefined, supported);
      const applied = mirror.replaceSnapshot(pathSnapshot(result, INITIAL_APPEARANCE, 1));
      expect(applied.status, name).toBe('applied');
    }
  });

  it('stores no -0 and round-trips the state through JSON unchanged', () => {
    for (const [name, input] of GRAMMAR_ROWS.map((row) => [row[0], row[1]] as const)) {
      const result = okOf(parsePathData(input));
      expect(
        result.points.some((value) => Object.is(value, -0)),
        name,
      ).toBe(false);
      const round = JSON.parse(JSON.stringify({ verbs: result.verbs, points: result.points })) as {
        verbs: string[];
        points: number[];
      };
      expect(round.verbs, name).toEqual(result.verbs);
      expect(sameBits(round.points, result.points), name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// V2-A7: limits at the limit and one past it
// ---------------------------------------------------------------------------------------------

describe('V2-A7 limits', () => {
  it('exposes the limits of section 1.5', () => {
    expect(MAX_INPUT_LENGTH).toBe(65_536);
    expect(MAX_VERBS).toBe(4_096);
    expect(MAX_COORDINATE).toBe(16_777_216);
  });

  it('parses 65,536 code units and rejects 65,537 without tokenizing', () => {
    const atLimit = parsePathData(longTail(65_536));
    expect(atLimit.status).toBe('ok');
    const over = longTail(65_537);
    const result = parsePathData(over);
    expect(result.status === 'error' && [result.code, result.offset]).toEqual([
      'input-too-long',
      65_536,
    ]);
    // An invalid text past the limit reports only the length: nothing was tokenized.
    const garbage = parsePathData('!'.repeat(65_537));
    expect(garbage.status === 'error' && garbage.code).toBe('input-too-long');
  });

  it('parses 4,096 verbs and rejects 4,097', () => {
    const build = (lines: number) => 'M 0 0' + ' L 0 0'.repeat(lines);
    const ok = okOf(parsePathData(build(4_095)));
    expect(ok.verbs).toHaveLength(4_096);
    const over = parsePathData(build(4_096));
    // The last group starts at 5 + 6 * 4095 + 3.
    expect(over.status === 'error' && [over.code, over.offset]).toEqual([
      'too-many-verbs',
      5 + 6 * 4_095 + 3,
    ]);
  });

  it('counts the implicit move after Z toward the verb limit', () => {
    // 1 move + 4,093 lines + Z = 4,095 verbs.
    const prefix = 'M 0 0' + ' L 0 0'.repeat(4_093) + ' Z';
    // 'L 1 1' adds an implicit move and a line: 4,097.
    const over = parsePathData(`${prefix} L 1 1`);
    expect(over.status === 'error' && [over.code, over.offset]).toEqual([
      'too-many-verbs',
      prefix.length + 3,
    ]);
    // One verb fewer fits exactly: 4,096.
    const fits = okOf(parsePathData(`${'M 0 0' + ' L 0 0'.repeat(4_092) + ' Z'} L 1 1`));
    expect(fits.verbs).toHaveLength(4_096);
    // Z Z at the limit: 4,095 verbs, then Z adds close only; another Z adds move and close.
    const zz = parsePathData(`${prefix} Z`);
    expect(zz.status === 'error' && zz.code).toBe('too-many-verbs');
    expect(zz.status === 'error' && zz.offset).toBe(prefix.length + 1);
  });

  it('accepts a coordinate of exactly 2^24 and rejects the next value above it', () => {
    expect(okOf(parsePathData('M 16777216 -16777216')).points).toEqual([16_777_216, -16_777_216]);
    const next = 2 ** 24 + 2 ** -28;
    expect(next).toBeGreaterThan(2 ** 24);
    const result = parsePathData(`M ${next} 0`);
    expect(result.status === 'error' && result.code).toBe('coordinate-out-of-range');
  });

  it('rejects a relative step that sums past 2^24, and a non-finite token', () => {
    const sum = parsePathData('M 16777216 0 l 1 0');
    expect(sum.status === 'error' && sum.code).toBe('coordinate-out-of-range');
    const big = parsePathData('M 1e400 0');
    expect(big.status === 'error' && big.code).toBe('coordinate-out-of-range');
  });

  it('accepts underflow to zero and to a subnormal', () => {
    const result = okOf(parsePathData('M 1e-400 5e-324'));
    expect(sameBits(result.points, [0, 5e-324])).toBe(true);
  });
});
