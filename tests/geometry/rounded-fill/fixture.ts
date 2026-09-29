import { readFileSync } from 'node:fs';
import type { FixtureRow, ProfileName } from './types.js';

const HEADER = ['# p3-rounded-fill-v1', '# seed 50333245', '# rows 202'];
const HEX = /^[0-9a-f]{16}$/u;
const EXPONENT_MASK = 0x7ff0000000000000n;

function finiteBits(text: string, label: string): bigint {
  if (!HEX.test(text)) throw new Error(`${label} bits`);
  const bits = BigInt(`0x${text}`);
  if ((bits & EXPONENT_MASK) === EXPONENT_MASK) throw new Error(`${label} must be finite`);
  return bits;
}

export function parseRoundedFillFixture(text: string): readonly FixtureRow[] {
  if (text.includes('\r')) throw new Error('fixture must use LF line endings');
  const lines = text.split('\n');
  if (lines.at(-1) !== '') throw new Error('fixture must end with LF');
  if (!HEADER.every((line, index) => lines[index]! === line))
    throw new Error('fixture header mismatch');
  const rows = lines.slice(3, -1).map((line, rowIndex) => parseRow(line, rowIndex));
  if (rows.length !== 202) throw new Error(`expected 202 fixture rows, received ${rows.length}`);
  return rows;
}

function parseRow(line: string, index: number): FixtureRow {
  const pieces = line.split(' | ');
  if (pieces.length < 2) throw new Error(`row ${index} has no contour`);
  const header = pieces[0]!.split(' ');
  if (header.length !== 5) throw new Error(`row ${index} header field count`);
  const id = header[0]!;
  const ruleText = header[1]!;
  const tauText = header[2]!;
  const expectationText = header[3]!;
  const profileText = header[4]!;
  if (ruleText !== 'nonzero' && ruleText !== 'evenodd') throw new Error(`row ${index} rule`);
  if (expectationText !== 'OK' && expectationText !== 'TOPOLOGY_AMBIGUOUS')
    throw new Error(`row ${index} expectation`);
  if (!['I', 'R16', 'D32', 'S192'].includes(profileText)) throw new Error(`row ${index} profile`);
  const tauBits = finiteBits(tauText, `row ${index} tau`);
  if ((tauBits & 0x7fffffffffffffffn) === 0n || tauBits >> 63n !== 0n)
    throw new Error(`row ${index} tau must be positive`);
  const contours = pieces.slice(1).map((piece, contourIndex) => {
    const points = piece.split(' ').map((point) => {
      const fields = point.split(',');
      if (fields.length !== 2 || !fields.every((field) => HEX.test(field))) {
        throw new Error(`row ${index} contour ${contourIndex} point`);
      }
      return [
        finiteBits(fields[0]!, `row ${index} contour ${contourIndex} x`),
        finiteBits(fields[1]!, `row ${index} contour ${contourIndex} y`),
      ] as const;
    });
    if (points.length < 2) throw new Error(`row ${index} contour ${contourIndex} too short`);
    return points;
  });
  return {
    id,
    rule: ruleText,
    tauBits,
    expectation: expectationText,
    profile: profileText as ProfileName,
    contours,
  };
}

export function readRoundedFillFixture(path: string): readonly FixtureRow[] {
  return parseRoundedFillFixture(readFileSync(path, 'utf8'));
}
