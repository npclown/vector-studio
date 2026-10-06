import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import { fixedProjectionFixtures, type ProjectionFixture } from '../mesh-projection/fixtures.js';
import { decodeCapture } from '../native-projection/decode.js';
import {
  add,
  bitsOf,
  div,
  fromBits,
  mul,
  rational,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';

/**
 * P3.1m N03 corpus: the literal M05 rows of docs/plans/p3-position-certificate-contract.md, the
 * pinned K and L archive loaders (SHA-256 asserted) and the exact L actual recovery.
 */

export type OriginPolicy = 'literal' | 'O-P1' | 'O-PX';
export type CertificateStatus = 'ADMITTED' | 'NOT_ADMITTED';

export type Expectation = Readonly<{
  status?: CertificateStatus;
  /** Exact M03 reason (null for ADMITTED). */
  reason?: string | null;
  /** A reason the outcome must not have (input-magnitude boundary row). */
  reasonNot?: string;
  /** Prospective max E^2 under Gamma8 with its stated significant digits. */
  delta2?: Readonly<{ value: number; digits: number }>;
  window?: Readonly<{ admitted: boolean; value?: number; digits?: number }>;
  gamma9?: Readonly<{
    status: CertificateStatus;
    reason: string | null;
    value?: number;
    digits?: number;
  }>;
  /** Pack must be nonzero on some referenced vertex. */
  packNonzero?: boolean;
  /** Pack must be exactly zero on every referenced vertex (dyadic rectangle rows). */
  packZero?: boolean;
}>;

export type LiteralRow = Readonly<{
  id: string;
  group: 'prospective' | 'n03' | 'term' | 'boundary';
  input: ProjectionInput;
  policy: OriginPolicy;
  /** Literal origin; derived-policy rows must re-derive exactly this origin. */
  origin: ProjectionPoint;
  /** O-PX grid size g (O-PX rows only). */
  g: number | null;
  /** Window half width D, or null when no window is evaluated. */
  halfWidth: number | null;
  expected: Expectation;
}>;

export type OriginSequence = Readonly<{
  id: 'N03P' | 'N03N';
  cameras: readonly number[];
  origins: readonly number[];
  rows: readonly LiteralRow[];
}>;

const IDENTITY = [1, 0, 0, 1] as const;
const R15 = [
  fromBits(0x3feee8dd4748bf15n),
  fromBits(0x3fd0907dc1930690n),
  fromBits(0xbfd0907dc1930690n),
  fromBits(0x3feee8dd4748bf15n),
] as const;

/** K's rectangle vertex and index layout. */
export function rectangle(width: number, height: number): ProjectionInput['mesh'] {
  return {
    vertices: [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

type Spec = Readonly<{
  mesh: ProjectionInput['mesh'];
  linear?: readonly [number, number, number, number];
  translation: ProjectionPoint;
  camera: ProjectionPoint;
  origin: ProjectionPoint;
  zoom: number;
  dpr: number;
  width: number;
  height: number;
}>;

function makeInput(id: string, spec: Spec): ProjectionInput {
  return {
    id,
    mesh: spec.mesh,
    affine: [...(spec.linear ?? IDENTITY), ...spec.translation],
    camera: spec.camera,
    origin: spec.origin,
    zoom: spec.zoom,
    dpr: spec.dpr,
    width: spec.width,
    height: spec.height,
  };
}

function row(
  id: string,
  group: LiteralRow['group'],
  spec: Spec,
  policy: OriginPolicy,
  expected: Expectation,
  window: Readonly<{ halfWidth: number | null; g?: number }> = { halfWidth: null },
): LiteralRow {
  return {
    id,
    group,
    input: makeInput(id, spec),
    policy,
    origin: spec.origin,
    g: window.g ?? null,
    halfWidth: window.halfWidth,
    expected,
  };
}

const CANCEL = {
  mesh: rectangle(16, 8),
  translation: [256.75, 1],
  camera: [255.75, 0],
} as const;
const ORDINARY = { zoom: 1, dpr: 1, width: 640, height: 360 } as const;
const ZERO_FRAME = { translation: [0, 0], camera: [0, 0], origin: [0, 0] } as const;

/** M05 prospective literal rows (excluding the N03 sequences). */
export function prospectiveRows(): readonly LiteralRow[] {
  const ext = (side: number, expected: Expectation) =>
    row(
      `EXT-${side}`,
      'prospective',
      { mesh: rectangle(side, side), ...ZERO_FRAME, ...ORDINARY },
      'literal',
      { ...expected, packZero: true },
    );
  const thin = fixedProjectionFixtures().find((fixture) => fixture.id === 'thin/collapse')!;
  return [
    row(
      'P1-CANCEL-64',
      'prospective',
      { ...CANCEL, origin: [0, 0], zoom: 64, dpr: 2, width: 1280, height: 720 },
      'O-P1',
      {
        status: 'NOT_ADMITTED',
        reason: 'position:0',
        delta2: { value: 7.31e-3, digits: 4 },
        window: { admitted: false },
        packZero: true,
      },
      { halfWidth: 512 },
    ),
    row(
      'PX-CANCEL-64',
      'prospective',
      { ...CANCEL, origin: [248, 0], zoom: 64, dpr: 2, width: 1280, height: 720 },
      'O-PX',
      {
        status: 'ADMITTED',
        reason: null,
        delta2: { value: 3.968e-5, digits: 4 },
        window: { admitted: true, value: 7.65e-5, digits: 3 },
        packZero: true,
      },
      { halfWidth: 16, g: 8 },
    ),
    row(
      'P1-CANCEL-1',
      'prospective',
      { ...CANCEL, origin: [0, 0], ...ORDINARY },
      'O-P1',
      {
        status: 'ADMITTED',
        reason: null,
        delta2: { value: 1.18e-6, digits: 3 },
        window: { admitted: true, value: 2.82e-6, digits: 3 },
        packZero: true,
      },
      { halfWidth: 512 },
    ),
    ext(4096, { status: 'ADMITTED', reason: null, delta2: { value: 5.92e-5, digits: 3 } }),
    ext(16384, { status: 'ADMITTED', reason: null, delta2: { value: 8.67e-4, digits: 3 } }),
    ext(32768, {
      status: 'ADMITTED',
      reason: null,
      delta2: { value: 3.416e-3, digits: 4 },
      gamma9: { status: 'NOT_ADMITTED', reason: 'position:0', value: 4.098e-3, digits: 4 },
    }),
    ext(65536, {
      status: 'NOT_ADMITTED',
      reason: 'position:0',
      delta2: { value: 1.356e-2, digits: 4 },
    }),
    {
      id: 'THIN',
      group: 'prospective',
      input: { ...thin.input, id: 'THIN' },
      policy: 'literal',
      origin: [0, 0],
      g: null,
      halfWidth: null,
      expected: { status: 'NOT_ADMITTED', reason: 'clearance:vertex' },
    },
  ];
}

function sequence(
  id: 'N03P' | 'N03N',
  cameras: readonly number[],
  origins: readonly number[],
): OriginSequence {
  return {
    id,
    cameras,
    origins,
    rows: cameras.map((camera, index) =>
      row(
        `${id}-${index}`,
        'n03',
        {
          mesh: rectangle(16, 8),
          translation: [0.25, 0.5],
          camera: [camera, 0],
          origin: [origins[index]!, 0],
          ...ORDINARY,
        },
        'O-P1',
        { status: 'ADMITTED', reason: null },
      ),
    ),
  };
}

/** M05 N03P/N03N camera sequences with their required O-P1 origins. */
export function originSequences(): readonly OriginSequence[] {
  return [
    sequence('N03P', [0, 255.75, 256, 511.75, 512, 512.25, 511.75], [0, 0, 0, 0, 0, 512, 512]),
    sequence('N03N', [0, -0.25, -256, -512, -512.25], [0, 0, 0, 0, -768]),
  ];
}

const LANE_ROW = {
  mesh: rectangle(16, 8),
  camera: [0, 0],
  origin: [0, 0],
  dpr: 1,
  width: 640,
  height: 360,
} as const;

/**
 * Input-magnitude boundary rows. The contract's "16x8 identity row with one vertex coordinate
 * equal to 2^60" cannot pass guard checks 1-3 if the other vertices stay near 0 (the midpoint
 * offsets would exceed 2^20), and binary64 cannot hold a 16-wide rectangle at 2^60 (ULP 256 above
 * 2^60, 128 below). The rows therefore use a 4096 x 8 rectangle ending at x = 2^60 with origin and
 * camera at its midpoint, so only guard check 4 distinguishes the pair: vertex 1 has x = 2^60 or
 * the next binary64 value 2^60 + 2^8.
 */
function magnitudeRow(id: string, x1: number, expected: Expectation): LiteralRow {
  const left = 2 ** 60 - 4096;
  const middle = 2 ** 60 - 2048;
  return row(
    id,
    'boundary',
    {
      mesh: {
        vertices: [
          [left, 0],
          [x1, 0],
          [2 ** 60, 8],
          [left, 8],
        ],
        indices: [0, 1, 2, 0, 2, 3],
      },
      translation: [0, 0],
      camera: [middle, 0],
      origin: [middle, 0],
      ...ORDINARY,
    },
    'literal',
    expected,
  );
}

/** M05 term-targeting rows and the input-magnitude boundary unit-control rows. */
export function termRows(): readonly LiteralRow[] {
  const px = prospectiveRows().find((candidate) => candidate.id === 'PX-CANCEL-64')!;
  return [
    row(
      'PACK-R15',
      'term',
      {
        mesh: rectangle(16, 8),
        linear: R15,
        translation: [0.1, 0.2],
        camera: [0.05, 0],
        origin: [0, 0],
        zoom: 1.5,
        dpr: 1,
        width: 960,
        height: 540,
      },
      'literal',
      { packNonzero: true },
    ),
    row(
      'FTZ',
      'term',
      {
        mesh: {
          vertices: [
            [0, 0],
            [2 ** -140, 0],
            [0, 1],
          ],
          indices: [0, 1, 2],
        },
        ...ZERO_FRAME,
        ...ORDINARY,
      },
      'literal',
      { status: 'NOT_ADMITTED', reason: 'clearance:vertex' },
    ),
    row('LANE-ZOOM-MAX', 'term', { ...LANE_ROW, translation: [0, 0], zoom: 2 ** 10 }, 'literal', {
      status: 'ADMITTED',
      reason: null,
    }),
    row(
      'LANE-ZOOM-OVER',
      'term',
      { ...LANE_ROW, translation: [0, 0], zoom: 2 ** 10 + 2 ** -13 },
      'literal',
      { status: 'NOT_ADMITTED', reason: 'lane-range' },
    ),
    row(
      'LANE-ANCHOR-MAX',
      'term',
      { ...LANE_ROW, translation: [2 ** 20 - 8, 0], zoom: 1 },
      'literal',
      { status: 'NOT_ADMITTED', reason: 'position:0' },
    ),
    row(
      'LANE-ANCHOR-OVER',
      'term',
      { ...LANE_ROW, translation: [2 ** 20 - 7, 0], zoom: 1 },
      'literal',
      { status: 'NOT_ADMITTED', reason: 'lane-range' },
    ),
    {
      ...px,
      id: 'WIN-EDGE',
      group: 'term',
      input: { ...px.input, id: 'WIN-EDGE', camera: [264, 0] },
      expected: { status: 'ADMITTED', reason: null, delta2: { value: 5.73e-5, digits: 3 } },
    },
    {
      ...px,
      id: 'WIN-EDGE-RESNAP',
      group: 'term',
      input: { ...px.input, id: 'WIN-EDGE-RESNAP', camera: [264.25, 0], origin: [264, 0] },
      origin: [264, 0],
      expected: {},
    },
    magnitudeRow('INPUT-MAG-2^60', 2 ** 60, { reasonNot: 'lane-range' }),
    magnitudeRow('INPUT-MAG-NEXT', 2 ** 60 + 2 ** 8, {
      status: 'NOT_ADMITTED',
      reason: 'lane-range',
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Pinned archives.

export const K_ARCHIVE = {
  path: 'docs/evidence/p3.1k-projection/observations-20261005T073041.json',
  sha256: 'b3b372db13ec4ad07bb31a8f79a8a99745f3b91ff8d0ed0e3d07a307e7a85dff',
} as const;

const L_ROOT = 'docs/evidence/p3.1l-native-projection/2026-10-06T07-28-57-641Z-22556';
export const L_CAPTURES = {
  chrome: {
    path: `${L_ROOT}/chrome/native_projection_corpus/capture.json`,
    sha256: '850899aca187ab736d137ba1668d130f84f3e9a10a2a8ef33e771784daf81092',
  },
  edge: {
    path: `${L_ROOT}/edge/native_projection_corpus/capture.json`,
    sha256: '4b79065e327ea0bed3a8d5d5afec1d6aa3890e66eb99503c38f5c4152cdc0469',
  },
} as const;

export type Browser = keyof typeof L_CAPTURES;

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read a pinned file and throw unless its SHA-256 matches. */
export function readPinned(relative: string, expected: string): string {
  const bytes = readFileSync(path.resolve(relative));
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`pinned:${relative}:${actual}`);
  return bytes.toString('utf8');
}

const hex = (value: number) => bitsOf(value).toString(16).padStart(16, '0');

/** The archived hex encoding of a projection input (K/L key order). */
export function encodeInput(input: ProjectionInput): unknown {
  return {
    id: input.id,
    mesh: {
      vertices: input.mesh.vertices.map(([x, y]) => [hex(x), hex(y)]),
      indices: [...input.mesh.indices],
    },
    affine: input.affine.map(hex),
    camera: input.camera.map(hex),
    origin: input.origin.map(hex),
    zoom: hex(input.zoom),
    dpr: hex(input.dpr),
    width: input.width,
    height: input.height,
  };
}

type ArchivedRow = Readonly<{ kind: string; id: string; input: unknown }>;

/** The 158 fixture rows, asserted against the pinned K archive inputs. */
export function loadFixtureRows(): readonly ProjectionFixture[] {
  const archive = JSON.parse(readPinned(K_ARCHIVE.path, K_ARCHIVE.sha256)) as {
    rows: readonly ArchivedRow[];
  };
  const meshRows = archive.rows.filter((candidate) => candidate.kind === 'mesh');
  const fixtures = fixedProjectionFixtures();
  if (fixtures.length !== 158 || meshRows.length !== 158) throw new Error('k-archive:count');
  fixtures.forEach((fixture, index) => {
    const archived = meshRows[index]!;
    if (
      archived.id !== fixture.id ||
      JSON.stringify(archived.input) !== JSON.stringify(encodeInput(fixture.input))
    )
      throw new Error(`k-archive:input:${index}`);
  });
  return fixtures;
}

export type CaptureRow = Readonly<{
  id: string;
  rowIndex: number;
  captureTag: number;
  input: unknown;
  vertexCount: number;
  capture: string;
  readbackBase64: string;
}>;

/** One browser's L capture rows, hash-pinned and asserted against the fixture inputs. */
export function loadCapture(
  browser: Browser,
  fixtures: readonly ProjectionFixture[],
): readonly CaptureRow[] {
  const { path: relative, sha256: expected } = L_CAPTURES[browser];
  const capture = JSON.parse(readPinned(relative, expected)) as { rows: readonly CaptureRow[] };
  if (capture.rows.length !== fixtures.length) throw new Error(`l-capture:${browser}:count`);
  capture.rows.forEach((candidate, index) => {
    const fixture = fixtures[index]!;
    if (
      candidate.rowIndex !== index ||
      candidate.id !== fixture.id ||
      candidate.capture !== 'CAPTURED' ||
      candidate.vertexCount !== fixture.input.mesh.vertices.length ||
      JSON.stringify(candidate.input) !== JSON.stringify(encodeInput(fixture.input))
    )
      throw new Error(`l-capture:${browser}:row:${index}`);
  });
  return capture.rows;
}

/** Unscaled exact value of a finite binary32 word. */
export function word32(word: number): Rational {
  const exponent = (word >>> 23) & 0xff;
  if (exponent === 0xff) throw new Error(`l-capture:nonfinite:${word}`);
  const fraction = BigInt(word & 0x7fffff);
  const magnitude = exponent === 0 ? fraction : (fraction | 0x800000n) << BigInt(exponent - 1);
  return rational(word >>> 31 === 1 ? -magnitude : magnitude, 1n << 149n);
}

const ONE = rational(1n);
const TWO = rational(2n);

/** Exact L actual: (nx + 1) * W / 2 and (1 - ny) * H / 2 from the decoded native clip words. */
export function nativeRecovered(
  input: ProjectionInput,
  captureRow: CaptureRow,
): readonly (readonly [Rational, Rational])[] {
  const decoded = decodeCapture(new Uint8Array(Buffer.from(captureRow.readbackBase64, 'base64')), {
    rowIndex: captureRow.rowIndex,
    expectedCount: input.mesh.vertices.length,
    captureTag: captureRow.captureTag,
  });
  if (decoded.status !== 'CAPTURED')
    throw new Error(`l-capture:${captureRow.id}:${decoded.reason}`);
  const width = rational(BigInt(input.width));
  const height = rational(BigInt(input.height));
  return decoded.clipWords.map(([x, y]) => [
    div(mul(add(word32(x), ONE), width), TWO),
    div(mul(sub(ONE, word32(y)), height), TWO),
  ]);
}
