import type { ScenePathVerb } from '@vector-studio/contracts';

// Visualization track V-2 (docs/plans/viz-v2-path-data-contract.md, sections 1.2 to 1.5): the
// SVG path-data parser and its mapping to scene path verbs and points. It is a character scanner
// over UTF-16 code units, strict (no browser leniency), stops at the first error and returns
// either all of the data or one error. This module has no DOM, GPU or WASM import.

/** Page limits (section 1.5). They are page limits, not kernel limits. */
export const MAX_INPUT_LENGTH = 65_536;
export const MAX_VERBS = 4_096;
export const MAX_COORDINATE = 2 ** 24;

export type PathDataErrorCode =
  | 'input-too-long'
  | 'missing-moveto'
  | 'unsupported-command'
  | 'unexpected-character'
  | 'expected-number'
  | 'invalid-number'
  | 'coordinate-out-of-range'
  | 'too-many-verbs';

export type PathDataOk = Readonly<{
  status: 'ok';
  verbs: ScenePathVerb[];
  points: number[];
}>;

export type PathDataError = Readonly<{
  status: 'error';
  code: PathDataErrorCode;
  /** 0-based index in UTF-16 code units. */
  offset: number;
  /** 1-based; LF, CR LF and a lone CR each end one line. */
  line: number;
  /** 1-based, in UTF-16 code units from the line start. */
  column: number;
  message: string;
}>;

export type PathDataResult = PathDataOk | PathDataError;

export const ARC_MESSAGE =
  'Arc commands (A/a) are not supported on this page. Convert arcs to curves first.';

const MESSAGES: Readonly<Record<PathDataErrorCode, string>> = {
  'input-too-long': `The path data is longer than ${MAX_INPUT_LENGTH} UTF-16 code units.`,
  'missing-moveto': 'The path data must start with M or m, but it starts with',
  'unsupported-command': ARC_MESSAGE,
  'unexpected-character': 'Unexpected character',
  'expected-number': 'A number is expected here, but',
  'invalid-number': 'Invalid number',
  'coordinate-out-of-range': `A coordinate is not finite or exceeds ${MAX_COORDINATE} in magnitude.`,
  'too-many-verbs': `The path would have more than ${MAX_VERBS} verbs.`,
};

const COMMAND_LETTERS = 'MmZzLlHhVvCcSsQqTtAa';

/** A count of numbers per argument group, per upper-cased command. */
const GROUP_SIZE: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
};

const isWsp = (code: number) =>
  code === 0x09 || code === 0x20 || code === 0x0a || code === 0x0c || code === 0x0d;
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isCommandLetter = (char: string) => char.length === 1 && COMMAND_LETTERS.includes(char);

/** `v === 0 ? 0 : v`: no emitted coordinate is ever -0 (section 1.2, signed zero). */
const plusZero = (value: number) => (value === 0 ? 0 : value);

function describeAt(input: string, offset: number): string {
  if (offset >= input.length) return 'the input ends';
  const codePoint = input.codePointAt(offset)!;
  return `'${String.fromCodePoint(codePoint)}'`;
}

function lineAndColumn(input: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x0a) {
      line += 1;
      lineStart = index + 1;
    } else if (code === 0x0d && input.charCodeAt(index + 1) !== 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

class ParseStop extends Error {
  public constructor(
    public readonly code: PathDataErrorCode,
    public readonly offset: number,
    public readonly detail: string,
  ) {
    super(code);
  }
}

function stop(code: PathDataErrorCode, offset: number, detail = ''): never {
  throw new ParseStop(code, offset, detail);
}

type Pair = readonly [number, number];

/**
 * Parses SVG path data (`d`) into scene path verbs and points, or reports the first error. Every
 * emitted coordinate is a finite binary64 value of magnitude at most 2^24 and never -0.
 */
export function parsePathData(input: string): PathDataResult {
  try {
    return scan(input);
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    const { line, column } = lineAndColumn(input, error.offset);
    return {
      status: 'error',
      code: error.code,
      offset: error.offset,
      line,
      column,
      message:
        error.detail === '' ? MESSAGES[error.code] : `${MESSAGES[error.code]} ${error.detail}`,
    };
  }
}

function scan(input: string): PathDataOk {
  if (input.length > MAX_INPUT_LENGTH) stop('input-too-long', MAX_INPUT_LENGTH);

  const length = input.length;
  const verbs: ScenePathVerb[] = [];
  const points: number[] = [];
  let pos = 0;

  const skipWsp = () => {
    while (pos < length && isWsp(input.charCodeAt(pos))) pos += 1;
  };

  // Current point, subpath start, and what the previous segment was (for S and T reflection).
  let px = 0;
  let py = 0;
  let sx = 0;
  let sy = 0;
  let previous: 'cubic' | 'quad' | 'other' = 'other';
  // The second cubic control point and the quadratic control point of the previous segment.
  let lastCubic: Pair = [0, 0];
  let lastQuad: Pair = [0, 0];
  let afterClose = false;

  /** Reads one number at `pos` (whitespace and the comma already skipped). */
  const readNumber = (): number => {
    if (pos >= length) stop('expected-number', pos, 'the input ends.');
    const char = input[pos]!;
    const code = input.charCodeAt(pos);
    const startsNumber = isDigit(code) || char === '.' || char === '+' || char === '-';
    if (!startsNumber) {
      if (isCommandLetter(char)) stop('expected-number', pos, `found '${char}'.`);
      stop('unexpected-character', pos, describeAt(input, pos) + '.');
    }
    const tokenStart = pos;
    let cursor = pos;
    if (char === '+' || char === '-') cursor += 1;
    let digitsBefore = 0;
    while (cursor < length && isDigit(input.charCodeAt(cursor))) {
      cursor += 1;
      digitsBefore += 1;
    }
    if (digitsBefore > 0) {
      if (input[cursor] === '.') {
        cursor += 1;
        while (cursor < length && isDigit(input.charCodeAt(cursor))) cursor += 1;
      }
    } else if (input[cursor] === '.' && isDigit(input.charCodeAt(cursor + 1))) {
      cursor += 1;
      while (cursor < length && isDigit(input.charCodeAt(cursor))) cursor += 1;
    } else {
      // `-`, `.`, `+.` and `+` : not a number; reported at the token's first character.
      let end = tokenStart + 1;
      if (input[end] === '.') end += 1;
      stop('invalid-number', tokenStart, `'${input.slice(tokenStart, end)}'.`);
    }
    if (input[cursor] === 'e' || input[cursor] === 'E') {
      const exponentAt = cursor;
      cursor += 1;
      if (input[cursor] === '+' || input[cursor] === '-') cursor += 1;
      if (!isDigit(input.charCodeAt(cursor))) {
        stop(
          'invalid-number',
          exponentAt,
          `'${input.slice(tokenStart, cursor)}' has no exponent digits.`,
        );
      }
      while (cursor < length && isDigit(input.charCodeAt(cursor))) cursor += 1;
    }
    const token = input.slice(tokenStart, cursor);
    pos = cursor;
    return Number(token);
  };

  const pushVerbs = (count: number, offset: number) => {
    if (verbs.length + count > MAX_VERBS) stop('too-many-verbs', offset);
  };

  const checked = (value: number, offset: number): number => {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
      stop('coordinate-out-of-range', offset);
    }
    return plusZero(value);
  };

  // The first non-whitespace character must be M or m.
  skipWsp();
  if (pos >= length) return { status: 'ok', verbs, points };
  if (input[pos] !== 'M' && input[pos] !== 'm') {
    stop('missing-moveto', pos, describeAt(input, pos) + '.');
  }

  while (pos < length) {
    // A command is expected here.
    const letter = input[pos]!;
    const letterAt = pos;
    if (letter === 'A' || letter === 'a') stop('unsupported-command', pos);
    const upper = letter.toUpperCase();
    if (!isCommandLetter(letter) || (upper !== 'Z' && GROUP_SIZE[upper] === undefined)) {
      stop('unexpected-character', pos, describeAt(input, pos) + '.');
    }
    pos += 1;

    if (upper === 'Z') {
      pushVerbs(afterClose ? 2 : 1, letterAt);
      if (afterClose) {
        verbs.push('move');
        points.push(sx, sy);
      }
      verbs.push('close');
      px = sx;
      py = sy;
      previous = 'other';
      afterClose = true;
      skipWsp();
      continue;
    }

    const relative = letter !== upper;
    const size = GROUP_SIZE[upper]!;
    skipWsp();
    if (input[pos] === ',') stop('unexpected-character', pos, "',' after a command letter.");

    let firstOfCommand = true;
    for (;;) {
      const groupAt = pos;
      const numbers: number[] = [];
      for (let index = 0; index < size; index += 1) {
        if (index > 0) {
          skipWsp();
          if (input[pos] === ',') {
            pos += 1;
            skipWsp();
          }
        }
        const value = readNumber();
        if (!Number.isFinite(value)) stop('coordinate-out-of-range', groupAt);
        numbers.push(value);
      }

      // Absolute point helpers: relative arguments add to the current point, one rounding each.
      const abs = (dx: number, dy: number): Pair => [
        checked(relative ? px + dx : dx, groupAt),
        checked(relative ? py + dy : dy, groupAt),
      ];
      const n = (index: number) => numbers[index]!;
      // A command after Z other than M or m starts with an implicit move to the subpath start.
      const implicitMove = afterClose && upper !== 'M' && firstOfCommand;
      const emit: Array<ScenePathVerb> = [];
      const emitPoints: number[] = [];
      let nextPrevious: 'cubic' | 'quad' | 'other' = 'other';
      let nextX = px;
      let nextY = py;

      switch (upper) {
        case 'M': {
          // After the first pair of M, further pairs are implicit L (m: l).
          if (firstOfCommand) {
            const [x, y] = abs(n(0), n(1));
            emit.push('move');
            emitPoints.push(x, y);
            nextX = x;
            nextY = y;
            sx = x;
            sy = y;
          } else {
            const [x, y] = abs(n(0), n(1));
            emit.push('line');
            emitPoints.push(x, y);
            nextX = x;
            nextY = y;
          }
          break;
        }
        case 'L': {
          const [x, y] = abs(n(0), n(1));
          emit.push('line');
          emitPoints.push(x, y);
          nextX = x;
          nextY = y;
          break;
        }
        case 'H': {
          const x = checked(relative ? px + n(0) : n(0), groupAt);
          emit.push('line');
          emitPoints.push(x, py);
          nextX = x;
          break;
        }
        case 'V': {
          const y = checked(relative ? py + n(0) : n(0), groupAt);
          emit.push('line');
          emitPoints.push(px, y);
          nextY = y;
          break;
        }
        case 'C': {
          const c1 = abs(n(0), n(1));
          const c2 = abs(n(2), n(3));
          const e = abs(n(4), n(5));
          emit.push('cubic');
          emitPoints.push(c1[0], c1[1], c2[0], c2[1], e[0], e[1]);
          nextX = e[0];
          nextY = e[1];
          nextPrevious = 'cubic';
          lastCubic = c2;
          break;
        }
        case 'S': {
          const c2 = abs(n(0), n(1));
          const e = abs(n(2), n(3));
          const r: Pair =
            previous === 'cubic'
              ? [checked(2 * px - lastCubic[0], groupAt), checked(2 * py - lastCubic[1], groupAt)]
              : [px, py];
          emit.push('cubic');
          emitPoints.push(r[0], r[1], c2[0], c2[1], e[0], e[1]);
          nextX = e[0];
          nextY = e[1];
          nextPrevious = 'cubic';
          lastCubic = c2;
          break;
        }
        case 'Q':
        case 'T': {
          let q: Pair;
          let e: Pair;
          if (upper === 'Q') {
            q = abs(n(0), n(1));
            e = abs(n(2), n(3));
          } else {
            q =
              previous === 'quad'
                ? [checked(2 * px - lastQuad[0], groupAt), checked(2 * py - lastQuad[1], groupAt)]
                : [px, py];
            e = abs(n(0), n(1));
          }
          // Degree elevation in binary64 (section 1.3); the signed-zero rule applies after it.
          const c1x = checked((px + 2 * q[0]) / 3, groupAt);
          const c1y = checked((py + 2 * q[1]) / 3, groupAt);
          const c2x = checked((e[0] + 2 * q[0]) / 3, groupAt);
          const c2y = checked((e[1] + 2 * q[1]) / 3, groupAt);
          emit.push('cubic');
          emitPoints.push(c1x, c1y, c2x, c2y, e[0], e[1]);
          nextX = e[0];
          nextY = e[1];
          nextPrevious = 'quad';
          lastQuad = q;
          break;
        }
      }

      pushVerbs(emit.length + (implicitMove ? 1 : 0), groupAt);
      if (implicitMove) {
        verbs.push('move');
        points.push(sx, sy);
      }
      verbs.push(...emit);
      points.push(...emitPoints);
      px = nextX;
      py = nextY;
      previous = nextPrevious;
      afterClose = false;
      firstOfCommand = false;

      // After a complete group: end, an implicit repeat, or the next command.
      skipWsp();
      if (pos >= length) break;
      const next = input[pos]!;
      if (next === ',') {
        const commaAt = pos;
        pos += 1;
        skipWsp();
        const after = input.charCodeAt(pos);
        const startsNumber =
          pos < length && (isDigit(after) || after === 0x2e || after === 0x2b || after === 0x2d);
        if (!startsNumber)
          stop('unexpected-character', commaAt, "',' that is not followed by a number.");
        continue;
      }
      const code = input.charCodeAt(pos);
      if (isDigit(code) || next === '.' || next === '+' || next === '-') continue;
      break;
    }
  }
  return { status: 'ok', verbs, points };
}
