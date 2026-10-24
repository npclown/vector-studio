// D9 E8 unit E8-U1: the E8 fixtures of docs/plans/p3-rounded-knot-topology-contract.md, E8
// addendum E8.6, as fill-v0 verbs and binary64 scalars. The path data is parsed as the V-2 page
// parses it: absolute M, L, C, S, Q, T, Z; S reflects the previous C/S second control, T the
// previous Q/T control, and Q is raised in binary64 to the cubic `(p + 2q)/3`, `(e + 2q)/3`.
// Every coordinate is `c + offset` in binary64 (E8-F4 and E8-C2 use 0.1). The native tests
// (`fill_export_tests::e8_svg_scalars`) parse the same strings the same way.

export type E8Fixture = Readonly<{
  id: string;
  data: string;
  offset: number;
  /** Tolerance exponents and the status after E8-U1 + E8-U2 (E8.6); only E8-F5 changed in E8-U2. */
  cases: readonly Readonly<{
    exponent: number;
    status: 'ok' | 'work-limit' | 'unsupported-geometry';
  }>[];
}>;

const range = (
  low: number,
  high: number,
  status: E8Fixture['cases'][number]['status'],
): E8Fixture['cases'] =>
  Array.from({ length: high - low + 1 }, (_, index) => ({ exponent: low + index, status }));

const at = (
  exponents: readonly number[],
  status: E8Fixture['cases'][number]['status'],
): E8Fixture['cases'] => exponents.map((exponent) => ({ exponent, status }));

export const E8_FIXTURES: readonly E8Fixture[] = Object.freeze([
  {
    id: 'E8-F1',
    data: 'M 0 0 L 0 -100 Q 100 -200 200 -100 T 400 -100 L 400 0 Z',
    offset: 0,
    cases: [...range(-8, -6, 'work-limit'), ...range(-5, 0, 'ok')],
  },
  {
    id: 'E8-F2',
    data: 'M 0 -100 Q 100 -200 200 -100 Z',
    offset: 0,
    cases: at([-7, -3, 0], 'ok'),
  },
  {
    id: 'E8-F3',
    data: 'M 100 0 C 100 55.22847498 55.22847498 100 0 100 C -55.22847498 100 -100 55.22847498 -100 0 Z',
    offset: 0,
    cases: at([-3, 0], 'ok'),
  },
  {
    id: 'E8-F4',
    data: 'M 0 0 C 20 -100 80 -100 100 -40 C 120 20 180 20 200 -40 L 200 50 L 0 50 Z',
    offset: 0.1,
    cases: at([-3, 0], 'ok'),
  },
  {
    id: 'E8-F5',
    data: 'M -2.9 33.4 C -2.9 31.4 17.1 23.6 17.1 33.4 C 17.1 47.7 -2.9 37.7 -2.9 33.4 Z',
    offset: 0,
    cases: [{ exponent: 0, status: 'ok' }],
  },
  {
    id: 'E8-F6',
    data: 'M 0 0 L 0 -90 Q 90 -180 180 -90 T 360 -90 L 360 0 Z',
    offset: 0,
    cases: range(-6, 0, 'ok'),
  },
  {
    id: 'E8-C1',
    data: 'M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z',
    offset: 0,
    cases: range(-6, 0, 'unsupported-geometry'),
  },
  {
    id: 'E8-C2',
    data: 'M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z',
    offset: 0.1,
    cases: at([-3, 0], 'unsupported-geometry'),
  },
]);

/** Fill-v0 verbs (MOVE 0, LINE 1, CUBIC 2, CLOSE 3) and scalars of the path data. */
export function e8PathScalars(
  data: string,
  offset: number,
): Readonly<{ verbs: number[]; points: number[] }> {
  const tokens = data.split(/\s+/u).filter((token) => token !== '');
  const verbs: number[] = [];
  const points: number[] = [];
  let index = 0;
  const number = () => Number(tokens[index++]) + offset;
  const pair = (): [number, number] => {
    const x = number();
    return [x, number()];
  };
  let current: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  while (index < tokens.length) {
    const command = tokens[index++]!;
    let cubic: [number, number] | null = null;
    let quad: [number, number] | null = null;
    if (command === 'M' || command === 'L') {
      current = pair();
      if (command === 'M') start = current;
      verbs.push(command === 'M' ? 0 : 1);
      points.push(...current);
    } else if (command === 'C' || command === 'S') {
      const one: [number, number] =
        command === 'C'
          ? pair()
          : lastCubic === null
            ? current
            : [2 * current[0] - lastCubic[0], 2 * current[1] - lastCubic[1]];
      const two = pair();
      const end = pair();
      verbs.push(2);
      points.push(...one, ...two, ...end);
      cubic = two;
      current = end;
    } else if (command === 'Q' || command === 'T') {
      const q: [number, number] =
        command === 'Q'
          ? pair()
          : lastQuad === null
            ? current
            : [2 * current[0] - lastQuad[0], 2 * current[1] - lastQuad[1]];
      const end = pair();
      verbs.push(2);
      points.push(
        (current[0] + 2 * q[0]) / 3,
        (current[1] + 2 * q[1]) / 3,
        (end[0] + 2 * q[0]) / 3,
        (end[1] + 2 * q[1]) / 3,
        ...end,
      );
      quad = q;
      current = end;
    } else if (command === 'Z') {
      verbs.push(3);
      current = start;
    } else {
      throw new Error(`unsupported E8 fixture command ${command}`);
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
  return { verbs, points };
}
