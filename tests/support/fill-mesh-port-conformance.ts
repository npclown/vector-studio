import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshPort,
  FillMeshRequest,
  FillMeshResult,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { checkFillMesh, checkFillRegion } from './fill-mesh-check.js';

// P3 V2 shared port conformance suite (P-C1), contract section j, cases
// C01-C18. Every case runs against the WASM adapter and the test double.
// It imports only contracts types and the independent mesh check.

type LineFillRule = FillMeshRequest['fillRule'];
type Point = readonly [x: number, y: number];

/** What a caller provides for one fresh port. */
export interface FillMeshPortHarness {
  readonly port: FillMeshPort;
  /** Terminal and idempotent disposal of the implementation. */
  dispose(): void;
  /** WASM run only: grows the implementation's linear memory. */
  forceMemoryGrowth?(): void;
}

const MOVE = 0;
const LINE = 1;
const CUBIC = 2;
const CLOSE = 3;

/** Path content of one conformance fixture. */
export interface FillFixturePath {
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

  cubic(points: readonly number[]): this {
    this.verbs.push(CUBIC);
    this.points.push(...points);
    return this;
  }

  close(): this {
    this.verbs.push(CLOSE);
    return this;
  }

  rectangle(x0: number, y0: number, x1: number, y1: number): this {
    return this.move(x0, y0).line(x1, y0).line(x1, y1).line(x0, y1).close();
  }

  reversedRectangle(x0: number, y0: number, x1: number, y1: number): this {
    return this.move(x0, y0).line(x0, y1).line(x1, y1).line(x1, y0).close();
  }

  build(): FillFixturePath {
    return { verbs: [...this.verbs], points: [...this.points] };
  }
}

const path = (): PathBuilder => new PathBuilder();

function longLinePath(): FillFixturePath {
  const builder = path().move(0, 0);
  for (let index = 0; index < 65_536; index += 1) builder.line(index % 7, index % 5);
  return builder.build();
}

/**
 * Every path the suite sends, by name. Region fixtures F01-F07, F10, F11 are
 * those of the P3 private contract; H1 and H2 are the hanging fixtures of
 * the V2 contract, section f.
 */
export const FILL_CONFORMANCE_PATHS = {
  square: path().rectangle(0, 0, 10, 10).build(),
  moveOnly: path().move(1, 2).build(),
  emptyVerbs: path().build(),
  grammarError: path().line(1, 1).build(),
  oddPointCount: { verbs: [MOVE], points: [0, 0, 1] },
  unknownVerb: { verbs: [MOVE, 9], points: [0, 0] },
  nanCoordinate: path().move(0, 0).line(Number.NaN, 1).build(),
  longLines: longLinePath(),
  fineCubic: path().move(0, 0).cubic([1, 2, 3, 2, 4, 0]).close().build(),
  f01: path().rectangle(0, 0, 10, 10).build(),
  f02: path().rectangle(0, 0, 10, 10).rectangle(3, 3, 7, 7).build(),
  f03: path().rectangle(0, 0, 10, 10).reversedRectangle(3, 3, 7, 7).build(),
  f04: path().rectangle(0, 0, 10, 10).rectangle(0, 0, 10, 10).build(),
  f05: path().rectangle(0, 0, 10, 10).reversedRectangle(0, 0, 10, 10).build(),
  f06: path().move(0, 0).line(4, 4).line(0, 4).line(4, 0).close().build(),
  f07: path().rectangle(0, 0, 2, 2).rectangle(2, 0, 4, 2).build(),
  f10: path().rectangle(0, 0, 4, 4).rectangle(2, 0, 6, 4).build(),
  f10Reversed: path().rectangle(0, 0, 4, 4).reversedRectangle(2, 0, 6, 4).build(),
  f11: path().rectangle(0, 0, 4, 4).rectangle(2, 4, 6, 8).build(),
  h1: path().rectangle(0, 0, 4, 4).rectangle(4, 1, 8, 3).build(),
  h2: path().rectangle(0, 0, 10, 10).rectangle(-5, 0, 0, 5).build(),
} as const satisfies Record<string, FillFixturePath>;

export type FillConformancePathName = keyof typeof FILL_CONFORMANCE_PATHS;

/** Region fixtures with their exact areas per rule; 0 means `empty`. */
export const FILL_REGION_FIXTURES: readonly Readonly<{
  name: FillConformancePathName;
  areas: Readonly<Record<LineFillRule, number>>;
}>[] = [
  { name: 'f01', areas: { nonzero: 100, evenodd: 100 } },
  { name: 'f02', areas: { nonzero: 100, evenodd: 84 } },
  { name: 'f03', areas: { nonzero: 84, evenodd: 84 } },
  { name: 'f04', areas: { nonzero: 100, evenodd: 0 } },
  { name: 'f05', areas: { nonzero: 0, evenodd: 0 } },
  { name: 'f06', areas: { nonzero: 8, evenodd: 8 } },
  { name: 'f07', areas: { nonzero: 8, evenodd: 8 } },
  { name: 'f10', areas: { nonzero: 24, evenodd: 16 } },
  { name: 'f10Reversed', areas: { nonzero: 16, evenodd: 16 } },
  { name: 'f11', areas: { nonzero: 32, evenodd: 32 } },
  { name: 'h1', areas: { nonzero: 24, evenodd: 24 } },
  { name: 'h2', areas: { nonzero: 125, evenodd: 125 } },
];

const REGION_EXPONENT = -3;

function request(
  requestId: number,
  name: FillConformancePathName,
  fillRule: LineFillRule = 'nonzero',
  toleranceExponent = REGION_EXPONENT,
): FillMeshRequest {
  const fixture = FILL_CONFORMANCE_PATHS[name];
  return {
    requestId,
    verbs: Uint8Array.from(fixture.verbs),
    points: Float64Array.from(fixture.points),
    fillRule,
    toleranceExponent,
  };
}

function contoursOf(fixture: FillFixturePath): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] | null = null;
  let scalar = 0;
  for (const verb of fixture.verbs) {
    if (verb === MOVE) {
      current = [[fixture.points[scalar]!, fixture.points[scalar + 1]!]];
      contours.push(current);
      scalar += 2;
    } else if (verb === LINE) {
      current!.push([fixture.points[scalar]!, fixture.points[scalar + 1]!]);
      scalar += 2;
    } else if (verb === CLOSE) {
      current = null;
    } else {
      throw new RangeError('region fixtures are line-only');
    }
  }
  return contours;
}

function expectMesh(mesh: FillMesh): void {
  expect(checkFillMesh(mesh)).toEqual([]);
}

/** Runs one batch and applies the section f mesh checks to every `ok` (C13). */
function build(port: FillMeshPort, requests: readonly FillMeshRequest[]): FillMeshResult[] {
  const batch = port.buildFillMeshes(requests);
  if (batch.status !== 'ok') throw new Error(`batch failed: ${JSON.stringify(batch)}`);
  expect(batch.results).toHaveLength(requests.length);
  for (const result of batch.results) {
    if (result.status === 'ok') expectMesh(result.mesh);
  }
  return [...batch.results];
}

function single(port: FillMeshPort, value: FillMeshRequest): FillMeshResult {
  return build(port, [value])[0]!;
}

function okMesh(result: FillMeshResult | undefined): FillMesh {
  if (result?.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.mesh;
}

function meshBits(mesh: FillMesh): Readonly<Record<string, unknown>> {
  return {
    positions: Array.from(new Uint32Array(mesh.positions.slice().buffer)),
    indices: Array.from(mesh.indices),
    boundaryEdges: Array.from(mesh.boundaryEdges),
    bounds: [mesh.bounds.minX, mesh.bounds.minY, mesh.bounds.maxX, mesh.bounds.maxY],
  };
}

function withoutEcho(result: FillMeshResult): unknown {
  if (result.status === 'ok') return { status: 'ok', mesh: meshBits(result.mesh) };
  if (result.status === 'failed') return { status: 'failed', code: result.code };
  return { status: 'empty' };
}

function boundaryPoints(mesh: FillMesh): [Point, Point][] {
  const point = (vertex: number): Point => [
    mesh.positions[2 * vertex]!,
    mesh.positions[2 * vertex + 1]!,
  ];
  const edges: [Point, Point][] = [];
  for (let slot = 0; slot < mesh.boundaryEdges.length; slot += 2) {
    edges.push([point(mesh.boundaryEdges[slot]!), point(mesh.boundaryEdges[slot + 1]!)]);
  }
  return edges;
}

export function describeFillMeshPortConformance(
  name: string,
  createPort: () => FillMeshPortHarness | Promise<FillMeshPortHarness>,
): void {
  describe(`fill-mesh port conformance: ${name}`, () => {
    async function withPort(run: (harness: FillMeshPortHarness) => void): Promise<void> {
      const harness = await createPort();
      try {
        run(harness);
      } finally {
        harness.dispose();
      }
    }

    it('C01 keeps result length and order for 0, 1 and 5 requests', () =>
      withPort(({ port }) => {
        expect(port.portVersion).toBe(0);
        expect(typeof port.operationId).toBe('string');
        expect(port.buildFillMeshes([])).toEqual({ status: 'ok', results: [] });
        expect(build(port, [request(7, 'square')]).map((r) => r.requestId)).toEqual([7]);
        const five = [
          request(5, 'square'),
          request(1, 'grammarError'),
          request(4, 'emptyVerbs'),
          request(2, 'f07'),
          request(3, 'moveOnly'),
        ];
        const results = build(port, five);
        expect(results.map((r) => r.requestId)).toEqual([5, 1, 4, 2, 3]);
        expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'empty', 'ok', 'empty']);
      }));

    it('C02 echoes requestId and toleranceExponent on ok, empty and failed', () =>
      withPort(({ port }) => {
        const results = build(port, [
          request(0, 'square', 'nonzero', -2),
          request(0xffff_ffff, 'emptyVerbs', 'evenodd', 17),
          request(123_456, 'grammarError', 'nonzero', -40),
        ]);
        expect(results.map((r) => [r.requestId, r.toleranceExponent, r.status])).toEqual([
          [0, -2, 'ok'],
          [0xffff_ffff, 17, 'empty'],
          [123_456, -40, 'failed'],
        ]);
      }));

    it('C03 returns empty for empty verbs and for a MOVE-only path', () =>
      withPort(({ port }) => {
        for (const fillRule of ['nonzero', 'evenodd'] as const) {
          const results = build(port, [
            request(1, 'emptyVerbs', fillRule),
            request(2, 'moveOnly', fillRule),
          ]);
          expect(results.map((r) => r.status)).toEqual(['empty', 'empty']);
        }
      }));

    it('C04 reports invalid-path for grammar, odd point count, unknown verb and NaN', () =>
      withPort(({ port }) => {
        const names = ['grammarError', 'oddPointCount', 'unknownVerb', 'nanCoordinate'] as const;
        const results = build(
          port,
          names.map((fixture, index) => request(index, fixture)),
        );
        for (const result of results) {
          expect(result).toEqual({
            requestId: result.requestId,
            toleranceExponent: REGION_EXPONENT,
            status: 'failed',
            code: 'invalid-path',
          });
        }
      }));

    it('C05 accepts exponents -1021..1023 and rejects -1022, 1024 and 1e10', () =>
      withPort(({ port }) => {
        const rejected = build(port, [
          request(1, 'square', 'nonzero', -1022),
          request(2, 'square', 'nonzero', 1024),
          request(3, 'square', 'nonzero', 1e10),
        ]);
        expect(rejected.map((r) => [r.toleranceExponent, r.status, 'code' in r && r.code])).toEqual(
          [
            [-1022, 'failed', 'invalid-tolerance'],
            [1024, 'failed', 'invalid-tolerance'],
            [1e10, 'failed', 'invalid-tolerance'],
          ],
        );
        const accepted = build(port, [
          request(4, 'square', 'nonzero', -1021),
          request(5, 'square', 'nonzero', 0),
          request(6, 'square', 'nonzero', 1023),
        ]);
        for (const result of accepted) {
          expect(result.status === 'failed' && result.code === 'invalid-tolerance').toBe(false);
        }
      }));

    it('C06 lets invalid-path beat invalid-tolerance on one path', () =>
      withPort(({ port }) => {
        expect(single(port, request(1, 'grammarError', 'nonzero', 5000))).toMatchObject({
          status: 'failed',
          code: 'invalid-path',
        });
      }));

    it('C07 isolates a failing path between two good paths', () =>
      withPort(({ port }) => {
        const first = single(port, request(1, 'square'));
        const last = single(port, request(3, 'f07', 'evenodd'));
        const batch = build(port, [
          request(1, 'square'),
          request(2, 'nanCoordinate'),
          request(3, 'f07', 'evenodd'),
        ]);
        expect(batch[1]).toMatchObject({ status: 'failed', code: 'invalid-path' });
        expect(meshBits(okMesh(batch[0]))).toEqual(meshBits(okMesh(first)));
        expect(meshBits(okMesh(batch[2]))).toEqual(meshBits(okMesh(last)));
      }));

    it('C08 publishes no mesh field on a failed or empty path', () =>
      withPort(({ port }) => {
        const results = build(port, [request(1, 'grammarError'), request(2, 'emptyVerbs')]);
        for (const result of results) expect('mesh' in result).toBe(false);
        expect(Object.keys(results[0]!).sort()).toEqual([
          'code',
          'requestId',
          'status',
          'toleranceExponent',
        ]);
      }));

    it('C09 rejects each invalid-request row with no results', () =>
      withPort(({ port }) => {
        const good = request(1, 'square');
        const sparse: FillMeshRequest[] = [];
        sparse[1] = good;
        const throwing = Object.defineProperty({ ...good }, 'requestId', {
          get(): number {
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
          [{ ...good, fillRule: 'NonZero' }],
          [{ ...good, fillRule: undefined }],
          [{ ...good, toleranceExponent: 0.5 }],
          [{ ...good, toleranceExponent: Number.NaN }],
          [{ ...good, toleranceExponent: Infinity }],
          [{ ...good, toleranceExponent: '0' }],
          [request(1, 'square'), { ...good, requestId: 2, fillRule: 'even-odd' }],
          [throwing],
        ];
        for (const row of rows) {
          const result = port.buildFillMeshes(row as readonly FillMeshRequest[]);
          expect(result).toEqual({ status: 'batch-failed', code: 'invalid-request' });
          expect('results' in result).toBe(false);
        }
        expect(okMesh(single(port, good)).indices.length).toBeGreaterThan(0);
      }));

    it('C10 keeps owned results across a second batch, memory growth and dispose', async () => {
      const harness = await createPort();
      const { port } = harness;
      const first = okMesh(single(port, request(1, 'f02', 'evenodd')));
      const snapshot = {
        positions: first.positions.slice(),
        indices: first.indices.slice(),
        boundaryEdges: first.boundaryEdges.slice(),
        bounds: { ...first.bounds },
      };
      build(port, [request(2, 'h1'), request(3, 'h2', 'evenodd'), request(4, 'f11')]);
      harness.forceMemoryGrowth?.();
      harness.dispose();
      expect(meshBits(first)).toEqual(meshBits(snapshot));
      expect(first.positions.buffer).not.toBe(snapshot.positions.buffer);
    });

    it('C11 returns disposed after dispose, also for an empty array', async () => {
      const harness = await createPort();
      harness.dispose();
      harness.dispose();
      const disposed: FillMeshBatchResult = { status: 'batch-failed', code: 'disposed' };
      expect(harness.port.buildFillMeshes([request(1, 'square')])).toEqual(disposed);
      expect(harness.port.buildFillMeshes([])).toEqual(disposed);
      expect(harness.port.buildFillMeshes('invalid' as never)).toEqual(disposed);
    });

    it('C12 is deterministic across repeats and batch positions', () =>
      withPort(({ port }) => {
        const results = build(port, [
          request(1, 'h2'),
          request(2, 'f06', 'evenodd'),
          request(3, 'h2'),
        ]);
        const reordered = build(port, [request(9, 'f06', 'evenodd'), request(8, 'h2')]);
        expect(withoutEcho(results[0]!)).toEqual(withoutEcho(results[2]!));
        expect(withoutEcho(results[0]!)).toEqual(withoutEcho(reordered[1]!));
        expect(withoutEcho(results[1]!)).toEqual(withoutEcho(reordered[0]!));
      }));

    it('C13 every ok mesh passes the section f checks', () =>
      withPort(({ port }) => {
        const requests = FILL_REGION_FIXTURES.flatMap(({ name: fixture }, index) => [
          request(2 * index, fixture, 'nonzero'),
          request(2 * index + 1, fixture, 'evenodd'),
        ]);
        const meshes = build(port, requests).filter((result) => result.status === 'ok');
        expect(meshes.length).toBeGreaterThan(0);
        for (const result of meshes) {
          const mesh = okMesh(result);
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

    for (const fillRule of ['nonzero', 'evenodd'] as const) {
      it(`C14 region fixtures under ${fillRule} equal the independent oracle`, () =>
        withPort(({ port }) => {
          const fixtures = FILL_REGION_FIXTURES.filter(
            ({ name: fixture }) => fixture !== 'h1' && fixture !== 'h2',
          );
          const results = build(
            port,
            fixtures.map(({ name: fixture }, index) => request(index, fixture, fillRule)),
          );
          fixtures.forEach(({ name: fixture, areas }, index) => {
            const result = results[index]!;
            if (areas[fillRule] === 0) {
              expect(result.status, fixture).toBe('empty');
              return;
            }
            const mesh = okMesh(result);
            expect(
              checkFillRegion(
                mesh,
                contoursOf(FILL_CONFORMANCE_PATHS[fixture]),
                fillRule,
                areas[fillRule],
              ),
              fixture,
            ).toEqual([]);
          });
          if (fillRule === 'evenodd') {
            expect(results[3]!.status).toBe('empty');
          }
          expect(results[4]!.status).toBe('empty');
        }));
    }

    for (const fillRule of ['nonzero', 'evenodd'] as const) {
      it(`C15 hanging fixtures under ${fillRule}: split edge interior, T-junction split`, () =>
        withPort(({ port }) => {
          const [h1, h2] = build(port, [
            request(1, 'h1', fillRule),
            request(2, 'h2', fillRule),
          ]).map(okMesh);
          for (const [mesh, fixture] of [
            [h1!, 'h1'],
            [h2!, 'h2'],
          ] as const) {
            expect(
              checkFillRegion(
                mesh,
                contoursOf(FILL_CONFORMANCE_PATHS[fixture]),
                fillRule,
                fixture === 'h1' ? 24 : 125,
              ),
            ).toEqual([]);
          }
          const h1Edges = boundaryPoints(h1!);
          expect(
            h1Edges.some(
              ([a, b]) =>
                a[0] === 4 && b[0] === 4 && Math.min(a[1], b[1]) < 3 && Math.max(a[1], b[1]) > 1,
            ),
          ).toBe(false);
          const h2Edges = boundaryPoints(h2!);
          expect(h2Edges).toContainEqual([
            [0, 10],
            [0, 5],
          ]);
          expect(
            h2Edges.some(([a, b]) => a[0] === 0 && b[0] === 0 && Math.min(a[1], b[1]) < 5),
          ).toBe(false);
        }));
    }

    // MOVE + 65,536 LINE = 65,537 output verbs, one above P2's frozen 65,536 output verbs per
    // path (P2 counts the MOVE). Today the fill export's cheap source cap (SourceLimit) fires
    // first; both map to work-limit, so the case holds whatever B1 does to the caps.
    it('C16 reports work-limit for MOVE + 65,536 LINE (65,537 output verbs)', () =>
      withPort(({ port }) => {
        expect(FILL_CONFORMANCE_PATHS.longLines.verbs).toHaveLength(65_537);
        expect(single(port, request(1, 'longLines', 'nonzero', 0))).toEqual({
          requestId: 1,
          toleranceExponent: 0,
          status: 'failed',
          code: 'work-limit',
        });
      }));

    it('C17 reports numeric-range for a cubic at e = -60', () =>
      withPort(({ port }) => {
        expect(single(port, request(1, 'fineCubic', 'nonzero', -60))).toEqual({
          requestId: 1,
          toleranceExponent: -60,
          status: 'failed',
          code: 'numeric-range',
        });
      }));

    it('C18 ignores request buffers mutated after the call', () =>
      withPort(({ port }) => {
        const mutable = request(1, 'f10', 'evenodd');
        const result = okMesh(single(port, mutable));
        const before = meshBits(result);
        mutable.verbs.fill(9);
        mutable.points.fill(Number.NaN);
        expect(meshBits(result)).toEqual(before);
        expect(meshBits(okMesh(single(port, request(2, 'f10', 'evenodd'))))).toEqual(before);
      }));
  });
}
