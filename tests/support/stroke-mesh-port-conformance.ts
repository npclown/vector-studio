import type {
  FillMeshRequest,
  StrokeMesh,
  StrokeMeshBatchResult,
  StrokeMeshPort,
  StrokeMeshRequest,
  StrokeMeshResult,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkStrokeExactRegion,
  strokeAreaEquals,
} from '../../packages/geometry-reference/src/index.js';
import { checkFillMesh } from './fill-mesh-check.js';
import type { FillMeshPortHarness } from './fill-mesh-port-conformance.js';

// P3 B2 stroke-mesh port conformance suite (docs/plans/p3-b2-stroke-contract.md, section
// 11.4), cases SC01-SC22. It mirrors V2's C01-C18 and runs against the WASM adapter in
// `pnpm test:geometry` and against the test double in `pnpm test:unit`. It imports only
// contracts types, the independent mesh check and the independent stroke oracle. No case
// needs a cubic stroke, so every case is independent of ST-U4. Results are functional
// evidence; precision is UNVERIFIED against the 0.25 physical-pixel target until B4.

type Cap = StrokeMeshRequest['cap'];
type Join = StrokeMeshRequest['join'];

/** What a caller provides for one fresh port. */
export interface StrokeMeshPortHarness {
  readonly port: StrokeMeshPort;
  /** Terminal and idempotent disposal of the implementation. */
  dispose(): void;
  /** WASM run only: grows the implementation's linear memory. */
  forceMemoryGrowth?(): void;
}

export interface StrokeMeshPortConformanceOptions {
  /** SC21: the operation id the implementation reports. */
  readonly operationId: string;
  /** SC22: a fresh fill-mesh port from the same source (the WASM run: the same module). */
  createFillPort(): FillMeshPortHarness | Promise<FillMeshPortHarness>;
}

const MOVE = 0;
const LINE = 1;
const CLOSE = 3;

/** Path content of one conformance fixture. */
export interface StrokeFixturePath {
  readonly verbs: readonly number[];
  readonly points: readonly number[];
}

class PathBuilder {
  readonly verbs: number[] = [];
  readonly points: number[] = [];

  move(x: number, y: number): this {
    this.verbs.push(MOVE);
    this.points.push(x, y);
    return this;
  }

  line(x: number, y: number): this {
    this.verbs.push(LINE);
    this.points.push(x, y);
    return this;
  }

  close(): this {
    this.verbs.push(CLOSE);
    return this;
  }

  build(): StrokeFixturePath {
    return { verbs: [...this.verbs], points: [...this.points] };
  }
}

const path = (): PathBuilder => new PathBuilder();

/** MOVE + 65,537 LINE: above P2 v1's 65,536 output verbs per path (SC17). */
function longLinePath(): StrokeFixturePath {
  const builder = path().move(0, 0);
  for (let index = 0; index < 65_537; index += 1) builder.line(index % 7, index % 5);
  return builder.build();
}

/** Every path the suite sends, by name; `stF*` are the section 11.2 fixtures. */
export const STROKE_CONFORMANCE_PATHS = {
  emptyVerbs: path().build(),
  grammarError: path().line(1, 1).build(),
  oddPointCount: { verbs: [MOVE], points: [0, 0, 1] },
  unknownVerb: { verbs: [MOVE, 9], points: [0, 0] },
  nanCoordinate: path().move(0, 0).line(Number.NaN, 1).build(),
  longLines: longLinePath(),
  stF1: path().move(0, 0).line(4, 0).build(),
  stF4: path().move(0, 0).line(4, 0).line(4, 4).build(),
  stF6: path().move(0, 0).line(4, 0).line(0, 0).build(),
  stF7: path().move(4, 5).build(),
  stF8: path().move(4, 5).line(4, 5).build(),
  stF9: path().move(4, 5).line(4, 5).close().build(),
  stF11: path().move(0, 0).line(4, 0).line(4, 4).line(0, 4).close().build(),
  stF14a: path().move(0, 2).line(4, 2).move(2, 0).line(2, 4).build(),
  stF14b: path().move(0, 2).line(4, 2).line(4, 4).line(2, 4).line(2, 0).build(),
  stF23: path()
    .move(2 ** 60, 0)
    .line(2 ** 60 + 2 ** 20, 0)
    .build(),
} as const satisfies Record<string, StrokeFixturePath>;

export type StrokeConformancePathName = keyof typeof STROKE_CONFORMANCE_PATHS;

/** A stroke style; section 11.2's default is `w = 2`, butt, miter `L = 4`. */
export interface StrokeFixtureStyle {
  readonly width: number;
  readonly cap: Cap;
  readonly join: Join;
  readonly miterLimit: number;
}

export const DEFAULT_STROKE_STYLE: StrokeFixtureStyle = {
  width: 2,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
};

export const STROKE_CAPS: readonly Cap[] = ['butt', 'round', 'square'];
export const STROKE_JOINS: readonly Join[] = ['miter', 'round', 'bevel'];

/** Area of the 16-gon at r = 1, its half and its quarter (section 11.2). */
export const SIXTEEN_GON = 3.0614674589207183;
export const SIXTEEN_GON_HALF = 1.5307337294603591;
export const SIXTEEN_GON_QUARTER = 0.7653668647301796;
const ROUND_TOLERANCE = 1e-12;

/** A named region fixture with its literal area (section 11.2). */
export interface StrokeAreaFixture {
  readonly id: string;
  readonly name: StrokeConformancePathName;
  readonly style: StrokeFixtureStyle;
  readonly area: number;
  /** 0 for an exact area; 1e-12 absolute for disk polygons. */
  readonly tolerance: number;
  /** The ideal pieces are exact polygons; ST-O4 applies (SC15). */
  readonly exactRegion: boolean;
}

const style = (overrides: Partial<StrokeFixtureStyle>): StrokeFixtureStyle => ({
  ...DEFAULT_STROKE_STYLE,
  ...overrides,
});

/** SC15's exact-region fixtures. */
export const STROKE_EXACT_FIXTURES: readonly StrokeAreaFixture[] = [
  {
    id: 'ST-F1',
    name: 'stF1',
    style: DEFAULT_STROKE_STYLE,
    area: 8,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F2',
    name: 'stF1',
    style: style({ cap: 'square' }),
    area: 12,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F6',
    name: 'stF6',
    style: DEFAULT_STROKE_STYLE,
    area: 8,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F11 miter',
    name: 'stF11',
    style: style({ miterLimit: 2 }),
    area: 32,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F14a',
    name: 'stF14a',
    style: DEFAULT_STROKE_STYLE,
    area: 12,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F14b',
    name: 'stF14b',
    style: style({ miterLimit: 2 }),
    area: 20,
    tolerance: 0,
    exactRegion: true,
  },
];

/** SC20's style fixtures: ST-F1 to ST-F3 by cap, ST-F4 by join and limit. */
export const STROKE_STYLE_FIXTURES: readonly StrokeAreaFixture[] = [
  {
    id: 'ST-F1',
    name: 'stF1',
    style: DEFAULT_STROKE_STYLE,
    area: 8,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F2',
    name: 'stF1',
    style: style({ cap: 'square' }),
    area: 12,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F3',
    name: 'stF1',
    style: style({ cap: 'round' }),
    area: 8 + SIXTEEN_GON,
    tolerance: ROUND_TOLERANCE,
    exactRegion: false,
  },
  {
    id: 'ST-F4 miter 2',
    name: 'stF4',
    style: style({ miterLimit: 2 }),
    area: 16,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F4 miter 1',
    name: 'stF4',
    style: style({ miterLimit: 1 }),
    area: 15.5,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F4 bevel',
    name: 'stF4',
    style: style({ join: 'bevel' }),
    area: 15.5,
    tolerance: 0,
    exactRegion: true,
  },
  {
    id: 'ST-F4 round',
    name: 'stF4',
    style: style({ join: 'round' }),
    area: 15 + SIXTEEN_GON_QUARTER,
    tolerance: ROUND_TOLERANCE,
    exactRegion: false,
  },
];

const EXPONENT = -3;

function request(
  requestId: number,
  name: StrokeConformancePathName,
  overrides: Partial<StrokeFixtureStyle> = {},
  toleranceExponent = EXPONENT,
): StrokeMeshRequest {
  const fixture = STROKE_CONFORMANCE_PATHS[name];
  return {
    requestId,
    verbs: Uint8Array.from(fixture.verbs),
    points: Float64Array.from(fixture.points),
    ...DEFAULT_STROKE_STYLE,
    ...overrides,
    toleranceExponent,
  };
}

function fixtureRequest(requestId: number, fixture: StrokeAreaFixture): StrokeMeshRequest {
  return request(requestId, fixture.name, fixture.style);
}

/** Runs one batch and applies the V2 mesh checks to every `ok` (SC14). */
function build(port: StrokeMeshPort, requests: readonly StrokeMeshRequest[]): StrokeMeshResult[] {
  const batch = port.buildStrokeMeshes(requests);
  if (batch.status !== 'ok') throw new Error(`batch failed: ${JSON.stringify(batch)}`);
  expect(batch.results).toHaveLength(requests.length);
  for (const result of batch.results) {
    if (result.status === 'ok') expect(checkFillMesh(result.mesh)).toEqual([]);
  }
  return [...batch.results];
}

function single(port: StrokeMeshPort, value: StrokeMeshRequest): StrokeMeshResult {
  return build(port, [value])[0]!;
}

function okMesh(result: StrokeMeshResult | undefined): StrokeMesh {
  if (result?.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.mesh;
}

function meshBits(mesh: StrokeMesh): Readonly<Record<string, unknown>> {
  return {
    positions: Array.from(new Uint32Array(mesh.positions.slice().buffer)),
    indices: Array.from(mesh.indices),
    boundaryEdges: Array.from(mesh.boundaryEdges),
    bounds: [mesh.bounds.minX, mesh.bounds.minY, mesh.bounds.maxX, mesh.bounds.maxY],
  };
}

function withoutEcho(result: StrokeMeshResult): unknown {
  if (result.status === 'ok') return { status: 'ok', mesh: meshBits(result.mesh) };
  if (result.status === 'failed') return { status: 'failed', code: result.code };
  return { status: 'empty' };
}

/** Float64 sum of the triangle areas. */
function meshArea(mesh: StrokeMesh): number {
  let twice = 0;
  for (let slot = 0; slot < mesh.indices.length; slot += 3) {
    const [a, b, c] = [mesh.indices[slot]!, mesh.indices[slot + 1]!, mesh.indices[slot + 2]!];
    twice +=
      (mesh.positions[2 * b]! - mesh.positions[2 * a]!) *
        (mesh.positions[2 * c + 1]! - mesh.positions[2 * a + 1]!) -
      (mesh.positions[2 * b + 1]! - mesh.positions[2 * a + 1]!) *
        (mesh.positions[2 * c]! - mesh.positions[2 * a]!);
  }
  return twice / 2;
}

function expectArea(mesh: StrokeMesh, fixture: StrokeAreaFixture): void {
  const area = meshArea(mesh);
  if (fixture.tolerance === 0) expect(area, fixture.id).toBe(fixture.area);
  else expect(Math.abs(area - fixture.area), fixture.id).toBeLessThanOrEqual(fixture.tolerance);
}

const FILL_SQUARE: FillMeshRequest = {
  requestId: 1,
  verbs: new Uint8Array([0, 1, 1, 1, 3]),
  points: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
  fillRule: 'nonzero',
  toleranceExponent: -3,
};

export function describeStrokeMeshPortConformance(
  name: string,
  createPort: () => StrokeMeshPortHarness | Promise<StrokeMeshPortHarness>,
  options: StrokeMeshPortConformanceOptions,
): void {
  describe(`stroke-mesh port conformance: ${name}`, () => {
    async function withPort(run: (harness: StrokeMeshPortHarness) => void): Promise<void> {
      const harness = await createPort();
      try {
        run(harness);
      } finally {
        harness.dispose();
      }
    }

    it('SC01 keeps result length and order for 0, 1 and 5 requests', () =>
      withPort(({ port }) => {
        expect(port.buildStrokeMeshes([])).toEqual({ status: 'ok', results: [] });
        expect(build(port, [request(7, 'stF1')]).map((r) => r.requestId)).toEqual([7]);
        const results = build(port, [
          request(5, 'stF1'),
          request(1, 'grammarError'),
          request(4, 'emptyVerbs'),
          request(2, 'stF4', { join: 'bevel' }),
          request(3, 'stF7'),
        ]);
        expect(results.map((r) => r.requestId)).toEqual([5, 1, 4, 2, 3]);
        expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'empty', 'ok', 'empty']);
      }));

    it('SC02 echoes requestId and toleranceExponent on ok, empty and failed', () =>
      withPort(({ port }) => {
        const results = build(port, [
          request(0, 'stF1', {}, -2),
          request(0xffff_ffff, 'emptyVerbs', {}, 17),
          request(123_456, 'grammarError', {}, -40),
          request(9, 'stF1', { width: -1 }, 3),
        ]);
        expect(results.map((r) => [r.requestId, r.toleranceExponent, r.status])).toEqual([
          [0, -2, 'ok'],
          [0xffff_ffff, 17, 'empty'],
          [123_456, -40, 'failed'],
          [9, 3, 'failed'],
        ]);
      }));

    it('SC03 returns empty for empty verbs, a MOVE-only path and width 0', () =>
      withPort(({ port }) => {
        for (const cap of STROKE_CAPS) {
          const results = build(port, [
            request(1, 'emptyVerbs', { cap }),
            request(2, 'stF7', { cap }),
            request(3, 'stF1', { cap, width: 0 }),
            request(4, 'stF11', { cap, width: -0 }),
          ]);
          expect(results.map((r) => r.status)).toEqual(['empty', 'empty', 'empty', 'empty']);
        }
      }));

    it('SC04 reports invalid-path for grammar, odd point count, unknown verb and NaN', () =>
      withPort(({ port }) => {
        const names = ['grammarError', 'oddPointCount', 'unknownVerb', 'nanCoordinate'] as const;
        const results = build(
          port,
          names.map((fixture, index) => request(index, fixture)),
        );
        for (const result of results) {
          expect(result).toEqual({
            requestId: result.requestId,
            toleranceExponent: EXPONENT,
            status: 'failed',
            code: 'invalid-path',
          });
        }
      }));

    it('SC05 reports invalid-stroke for bad widths and miter limits', () =>
      withPort(({ port }) => {
        const overrides: Partial<StrokeFixtureStyle>[] = [
          { width: -1 },
          { width: Number.NaN },
          { width: Infinity },
          { miterLimit: 0.5 },
          { miterLimit: Number.NaN },
          { miterLimit: Infinity },
          { join: 'bevel', miterLimit: 0.5 },
          { join: 'round', width: -Infinity },
        ];
        const results = build(
          port,
          overrides.map((override, index) => request(index, 'stF1', override)),
        );
        for (const result of results) {
          expect(result).toEqual({
            requestId: result.requestId,
            toleranceExponent: EXPONENT,
            status: 'failed',
            code: 'invalid-stroke',
          });
        }
      }));

    it('SC06 rejects exponents -1021, 1024 and 1e10 and accepts -1020, 0 and 1023', () =>
      withPort(({ port }) => {
        const rejected = build(port, [
          request(1, 'stF1', {}, -1021),
          request(2, 'stF1', {}, 1024),
          request(3, 'stF1', {}, 1e10),
        ]);
        expect(rejected.map((r) => [r.toleranceExponent, r.status, 'code' in r && r.code])).toEqual(
          [
            [-1021, 'failed', 'invalid-tolerance'],
            [1024, 'failed', 'invalid-tolerance'],
            [1e10, 'failed', 'invalid-tolerance'],
          ],
        );
        const accepted = build(port, [
          request(4, 'stF1', {}, -1020),
          request(5, 'stF1', {}, 0),
          request(6, 'stF1', {}, 1023),
        ]);
        for (const result of accepted) {
          expect(result.status === 'failed' && result.code === 'invalid-tolerance').toBe(false);
        }
      }));

    it('SC07 lets invalid-path beat invalid-stroke beat invalid-tolerance', () =>
      withPort(({ port }) => {
        const results = build(port, [
          request(1, 'grammarError', { width: -1, miterLimit: 0.5 }, 5000),
          request(2, 'stF1', { width: -1, miterLimit: 0.5 }, 5000),
          request(3, 'stF1', {}, 5000),
          request(4, 'emptyVerbs', { width: Number.NaN }, 5000),
          request(5, 'emptyVerbs', {}, 5000),
        ]);
        expect(results.map((r) => r.status === 'failed' && r.code)).toEqual([
          'invalid-path',
          'invalid-stroke',
          'invalid-tolerance',
          'invalid-stroke',
          'invalid-tolerance',
        ]);
      }));

    it('SC08 isolates a failing path between two good paths', () =>
      withPort(({ port }) => {
        const first = single(port, request(1, 'stF1', { cap: 'round' }));
        const last = single(port, request(3, 'stF14b', { miterLimit: 2 }));
        const batch = build(port, [
          request(1, 'stF1', { cap: 'round' }),
          request(2, 'nanCoordinate'),
          request(3, 'stF14b', { miterLimit: 2 }),
        ]);
        expect(batch[1]).toMatchObject({ status: 'failed', code: 'invalid-path' });
        expect(meshBits(okMesh(batch[0]))).toEqual(meshBits(okMesh(first)));
        expect(meshBits(okMesh(batch[2]))).toEqual(meshBits(okMesh(last)));
      }));

    it('SC09 publishes no mesh field on a failed or empty path', () =>
      withPort(({ port }) => {
        const results = build(port, [
          request(1, 'grammarError'),
          request(2, 'emptyVerbs'),
          request(3, 'stF1', { width: Number.NaN }),
        ]);
        for (const result of results) expect('mesh' in result).toBe(false);
        for (const index of [0, 2]) {
          expect(Object.keys(results[index]!).sort()).toEqual([
            'code',
            'requestId',
            'status',
            'toleranceExponent',
          ]);
        }
        expect(Object.keys(results[1]!).sort()).toEqual([
          'requestId',
          'status',
          'toleranceExponent',
        ]);
      }));

    it('SC10 rejects each invalid-request row with no results', () =>
      withPort(({ port }) => {
        const good = request(1, 'stF1');
        const sparse: StrokeMeshRequest[] = [];
        sparse[1] = good;
        const throwing = Object.defineProperty({ ...good }, 'requestId', {
          get(): number {
            throw new Error('caller getter');
          },
        });
        const throwingCap = Object.defineProperty({ ...good }, 'cap', {
          get(): string {
            throw new Error('caller getter');
          },
        });
        const rows: readonly unknown[] = [
          { length: 1, 0: good },
          'not an array',
          null,
          sparse,
          [null],
          [7],
          [{ ...good, requestId: -1 }],
          [{ ...good, requestId: 1.5 }],
          [{ ...good, requestId: 2 ** 32 }],
          [{ ...good, requestId: Number.NaN }],
          [{ ...good, requestId: '1' }],
          [good, { ...good }],
          [{ ...good, verbs: [0, 1] }],
          [{ ...good, verbs: new Int8Array(2) }],
          [{ ...good, points: [0, 0] }],
          [{ ...good, points: new Float32Array(2) }],
          [{ ...good, cap: 'Butt' }],
          [{ ...good, cap: 'flat' }],
          [{ ...good, cap: 0 }],
          [{ ...good, cap: undefined }],
          [{ ...good, join: 'Miter' }],
          [{ ...good, join: 'arcs' }],
          [{ ...good, join: undefined }],
          [{ ...good, width: '2' }],
          [{ ...good, width: undefined }],
          [{ ...good, width: null }],
          [{ ...good, width: 2n }],
          [{ ...good, miterLimit: '4' }],
          [{ ...good, miterLimit: undefined }],
          [{ ...good, toleranceExponent: 0.5 }],
          [{ ...good, toleranceExponent: Number.NaN }],
          [{ ...good, toleranceExponent: Infinity }],
          [{ ...good, toleranceExponent: '0' }],
          [request(1, 'stF1'), { ...good, requestId: 2, join: 'mitre' }],
          [throwing],
          [throwingCap],
        ];
        for (const row of rows) {
          const result = port.buildStrokeMeshes(row as readonly StrokeMeshRequest[]);
          expect(result).toEqual({ status: 'batch-failed', code: 'invalid-request' });
          expect('results' in result).toBe(false);
        }
        expect(okMesh(single(port, good)).indices.length).toBeGreaterThan(0);
      }));

    it('SC11 keeps owned results across a second batch, memory growth and dispose', async () => {
      const harness = await createPort();
      const { port } = harness;
      const first = okMesh(single(port, request(1, 'stF11', { join: 'round', cap: 'round' })));
      const snapshot = {
        positions: first.positions.slice(),
        indices: first.indices.slice(),
        boundaryEdges: first.boundaryEdges.slice(),
        bounds: { ...first.bounds },
      };
      build(port, [
        request(2, 'stF14a'),
        request(3, 'stF14b', { miterLimit: 2 }),
        request(4, 'stF4'),
      ]);
      harness.forceMemoryGrowth?.();
      harness.dispose();
      expect(meshBits(first)).toEqual(meshBits(snapshot));
      expect(first.positions.buffer).not.toBe(snapshot.positions.buffer);
    });

    it('SC12 returns disposed after dispose, also for an empty array', async () => {
      const harness = await createPort();
      harness.dispose();
      harness.dispose();
      const disposed: StrokeMeshBatchResult = { status: 'batch-failed', code: 'disposed' };
      expect(harness.port.buildStrokeMeshes([request(1, 'stF1')])).toEqual(disposed);
      expect(harness.port.buildStrokeMeshes([])).toEqual(disposed);
      expect(harness.port.buildStrokeMeshes('invalid' as never)).toEqual(disposed);
    });

    it('SC13 is deterministic across repeats and batch positions', () =>
      withPort(({ port }) => {
        const results = build(port, [
          request(1, 'stF11', { join: 'round' }),
          request(2, 'stF14b', { miterLimit: 2 }),
          request(3, 'stF11', { join: 'round' }),
        ]);
        const reordered = build(port, [
          request(9, 'stF14b', { miterLimit: 2 }),
          request(8, 'stF11', { join: 'round' }),
        ]);
        expect(withoutEcho(results[0]!)).toEqual(withoutEcho(results[2]!));
        expect(withoutEcho(results[0]!)).toEqual(withoutEcho(reordered[1]!));
        expect(withoutEcho(results[1]!)).toEqual(withoutEcho(reordered[0]!));
      }));

    it('SC14 every ok mesh passes the V2 mesh checks, with positive triangles', () =>
      withPort(({ port }) => {
        const fixtures = [...STROKE_EXACT_FIXTURES, ...STROKE_STYLE_FIXTURES];
        const meshes = build(
          port,
          fixtures.map((fixture, index) => fixtureRequest(index, fixture)),
        ).map(okMesh);
        expect(meshes).toHaveLength(fixtures.length);
        for (const mesh of meshes) {
          expect(checkFillMesh(mesh)).toEqual([]);
          for (let slot = 0; slot < mesh.indices.length; slot += 3) {
            const [a, b, c] = [
              mesh.indices[slot]!,
              mesh.indices[slot + 1]!,
              mesh.indices[slot + 2]!,
            ];
            const cross =
              (mesh.positions[2 * b]! - mesh.positions[2 * a]!) *
                (mesh.positions[2 * c + 1]! - mesh.positions[2 * a + 1]!) -
              (mesh.positions[2 * b + 1]! - mesh.positions[2 * a + 1]!) *
                (mesh.positions[2 * c]! - mesh.positions[2 * a]!);
            expect(cross).toBeGreaterThan(0);
          }
        }
      }));

    it('SC15 exact fixtures equal the independent oracle in area and region', () =>
      withPort(({ port }) => {
        const requests = STROKE_EXACT_FIXTURES.map((fixture, index) =>
          fixtureRequest(index, fixture),
        );
        const results = build(port, requests);
        STROKE_EXACT_FIXTURES.forEach((fixture, index) => {
          const mesh = okMesh(results[index]);
          expectArea(mesh, fixture);
          const region = checkStrokeExactRegion(requests[index]!, mesh);
          expect(region.findings, fixture.id).toEqual([]);
          expect(region.ok, fixture.id).toBe(true);
          expect(strokeAreaEquals(region.idealArea!, fixture.area), fixture.id).toBe(true);
        });
        const bounds = (index: number) => okMesh(results[index]).bounds;
        expect(bounds(0)).toEqual({ minX: 0, minY: -1, maxX: 4, maxY: 1 });
        expect(bounds(1)).toEqual({ minX: -1, minY: -1, maxX: 5, maxY: 1 });
        expect(bounds(3)).toEqual({ minX: -1, minY: -1, maxX: 5, maxY: 5 });
      }));

    it('SC16 ST-F7 and ST-F9 are empty for every cap and join; ST-F8 square has its bounds', () =>
      withPort(({ port }) => {
        const requests: StrokeMeshRequest[] = [];
        for (const cap of STROKE_CAPS) {
          for (const join of STROKE_JOINS) {
            requests.push(request(requests.length, 'stF7', { cap, join }));
            requests.push(request(requests.length, 'stF9', { cap, join }));
          }
        }
        for (const result of build(port, requests)) expect(result.status).toBe('empty');
        const square = okMesh(single(port, request(1, 'stF8', { cap: 'square' })));
        expect(square.bounds).toEqual({ minX: 3, minY: 4, maxX: 5, maxY: 6 });
        expect(meshArea(square)).toBe(4);
        expect(single(port, request(2, 'stF8')).status).toBe('empty');
      }));

    it('SC17 reports work-limit for MOVE + 65,537 LINE', () =>
      withPort(({ port }) => {
        expect(STROKE_CONFORMANCE_PATHS.longLines.verbs).toHaveLength(65_538);
        expect(single(port, request(1, 'longLines', {}, 0))).toEqual({
          requestId: 1,
          toleranceExponent: 0,
          status: 'failed',
          code: 'work-limit',
        });
      }));

    it('SC18 reports numeric-range for ST-F23', () =>
      withPort(({ port }) => {
        for (const cap of STROKE_CAPS) {
          expect(single(port, request(1, 'stF23', { cap }))).toEqual({
            requestId: 1,
            toleranceExponent: EXPONENT,
            status: 'failed',
            code: 'numeric-range',
          });
        }
      }));

    it('SC19 ignores request buffers mutated after the call', () =>
      withPort(({ port }) => {
        const mutable = request(1, 'stF14b', { miterLimit: 2 });
        const result = okMesh(single(port, mutable));
        const before = meshBits(result);
        mutable.verbs.fill(9);
        mutable.points.fill(Number.NaN);
        expect(meshBits(result)).toEqual(before);
        expect(meshBits(okMesh(single(port, request(2, 'stF14b', { miterLimit: 2 }))))).toEqual(
          before,
        );
      }));

    it('SC20 stroke values reach the mesh: areas per cap, join and miter limit', () =>
      withPort(({ port }) => {
        const results = build(
          port,
          STROKE_STYLE_FIXTURES.map((fixture, index) => fixtureRequest(index, fixture)),
        );
        STROKE_STYLE_FIXTURES.forEach((fixture, index) => {
          expectArea(okMesh(results[index]), fixture);
        });
        // ST-F1 to ST-F3 differ only in cap, so their meshes differ.
        const capMeshes = results.slice(0, 3).map((result) => meshBits(okMesh(result)));
        expect(capMeshes[0]).not.toEqual(capMeshes[1]);
        expect(capMeshes[1]).not.toEqual(capMeshes[2]);
        expect(capMeshes[0]).not.toEqual(capMeshes[2]);
      }));

    it('SC21 reports its operationId and portVersion 0', () =>
      withPort(({ port }) => {
        expect(port.portVersion).toBe(0);
        expect(port.operationId).toBe(options.operationId);
        expect(port.operationId.length).toBeGreaterThan(0);
        expect(typeof port.buildStrokeMeshes).toBe('function');
      }));

    it('SC22 isolates a fill port and a stroke port from one source', async () => {
      for (const disposeFirst of ['stroke', 'fill'] as const) {
        const stroke = await createPort();
        const fill = await options.createFillPort();
        try {
          expect(single(stroke.port, request(1, 'stF1')).status).toBe('ok');
          expect(fill.port.buildFillMeshes([FILL_SQUARE]).status).toBe('ok');
          if (disposeFirst === 'stroke') {
            stroke.dispose();
            expect(stroke.port.buildStrokeMeshes([request(1, 'stF1')])).toEqual({
              status: 'batch-failed',
              code: 'disposed',
            });
            const after = fill.port.buildFillMeshes([FILL_SQUARE]);
            expect(after.status).toBe('ok');
          } else {
            fill.dispose();
            expect(fill.port.buildFillMeshes([FILL_SQUARE])).toEqual({
              status: 'batch-failed',
              code: 'disposed',
            });
            expect(okMesh(single(stroke.port, request(2, 'stF4'))).indices.length).toBeGreaterThan(
              0,
            );
          }
        } finally {
          stroke.dispose();
          fill.dispose();
        }
      }
    });
  });
}
