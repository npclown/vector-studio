import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditMeshProjection, roundExact32, roundExact64 } from './mesh-projection/audit.js';
import { fixedProjectionFixtures, legacyProjectionCounter } from './mesh-projection/fixtures.js';
import {
  simulateMeshProjection,
  type ProjectionInput,
  type ProjectionObservation,
} from './mesh-projection/model.js';
import { add, bitsOf, exactInteger, fromBits, mul, rational, sub } from './rounded-fill/exact.js';

const bit = (value: number) => bitsOf(value).toString(16).padStart(16, '0');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function encoded(value: unknown): unknown {
  if (typeof value === 'number') return bit(value);
  if (Array.isArray(value)) return value.map(encoded);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encoded(item)]));
  return value;
}
function sourceHash(relative: string): string {
  return hash(readFileSync(path.resolve(relative)));
}
function metadataHash(value: unknown): string {
  return hash(`${JSON.stringify(encoded(value))}\n`);
}
function encodedInput(input: ProjectionInput): unknown {
  return {
    id: input.id,
    mesh: { vertices: encoded(input.mesh.vertices), indices: [...input.mesh.indices] },
    affine: encoded(input.affine),
    camera: encoded(input.camera),
    origin: encoded(input.origin),
    zoom: bit(input.zoom),
    dpr: bit(input.dpr),
    width: input.width,
    height: input.height,
  };
}
function expectFailureStage(observation: ProjectionObservation, stage: string): void {
  expect(observation.ok).toBe(false);
  if (observation.ok) throw new Error(`expected ${stage} failure`);
  expect(observation.stage).toBe(stage);
}
function legacyObservation() {
  const row = legacyProjectionCounter();
  const [a, b, c, d] = row.affine.map(Math.fround);
  const x = Math.fround(row.point[0]);
  const y = Math.fround(row.point[1]);
  const tx = Math.fround(-row.origin[0]);
  const ty = Math.fround(-row.origin[1]);
  const ox = Math.fround(row.origin[0] - row.camera[0]);
  const oy = Math.fround(row.origin[1] - row.camera[1]);
  const px = Math.fround(
    Math.fround(Math.fround(Math.fround(a! * x) + Math.fround(c! * y)) + tx) + ox,
  );
  const py = Math.fround(
    Math.fround(Math.fround(Math.fround(b! * x) + Math.fround(d! * y)) + ty) + oy,
  );
  const actual = [
    Math.fround(Math.fround(px * 64) * 2),
    Math.fround(Math.fround(py * 64) * 2),
  ] as const;
  const q = (value: number) => rational(exactInteger(bitsOf(value)), 1n << 1074n);
  const reference = [
    mul(
      mul(
        sub(
          add(
            add(mul(q(row.affine[0]), q(row.point[0])), mul(q(row.affine[2]), q(row.point[1]))),
            q(row.affine[4]),
          ),
          q(row.camera[0]),
        ),
        q(row.zoom),
      ),
      q(row.dpr),
    ),
    mul(
      mul(
        sub(
          add(
            add(mul(q(row.affine[1]), q(row.point[0])), mul(q(row.affine[3]), q(row.point[1]))),
            q(row.affine[5]),
          ),
          q(row.camera[1]),
        ),
        q(row.zoom),
      ),
      q(row.dpr),
    ),
  ] as const;
  const delta = [sub(q(actual[0]), reference[0]), sub(q(actual[1]), reference[1])] as const;
  const squared = add(mul(delta[0], delta[0]), mul(delta[1], delta[1]));
  const serializedDelta = delta.map(({ n, d }) => ({ n: n.toString(), d: d.toString() }));
  return {
    row,
    actual,
    delta,
    serializedDelta,
    squared: { n: squared.n.toString(), d: squared.d.toString() },
  };
}

describe('P3.1k mesh-local projection experiment', () => {
  it('records all 159 frozen rows before asserting required dispositions', () => {
    const fixtures = fixedProjectionFixtures();
    expect(fixtures).toHaveLength(158);
    const errors: string[] = [];
    const records = fixtures.map((fixture) => {
      const candidate = simulateMeshProjection(fixture.input);
      let audit: unknown;
      try {
        audit = auditMeshProjection(fixture.input, candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${fixture.id}:${message}`);
        audit = { error: message };
      }
      return {
        kind: 'mesh',
        id: fixture.id,
        family: fixture.family,
        disposition: fixture.disposition,
        input: encodedInput(fixture.input),
        ...(fixture.carrierMetadata === undefined
          ? {}
          : { carrierMetadataSha256: metadataHash(fixture.carrierMetadata) }),
        candidate: encoded(candidate),
        audit,
      };
    });
    const legacy = legacyObservation();
    const allRows = [
      ...records,
      {
        kind: 'legacy',
        id: legacy.row.id,
        family: 'legacy',
        disposition: 'LEGACY_COUNTER',
        input: encoded(legacy.row),
        componentDelta: legacy.serializedDelta,
        squared: legacy.squared,
      },
    ];
    expect(allRows).toHaveLength(159);
    const self = fileURLToPath(import.meta.url);
    const sourceHashes = Object.fromEntries(
      [
        'tests/geometry/mesh-projection/model.ts',
        'tests/geometry/mesh-projection/audit.ts',
        'tests/geometry/mesh-projection/fixtures.ts',
        'tests/geometry/mesh-projection.test.ts',
      ].map((relative) => [
        relative,
        relative.endsWith('.test.ts') ? hash(readFileSync(self)) : sourceHash(relative),
      ]),
    );
    const artifact = {
      schema: 'p3-mesh-projection-v1',
      model: 'local-midpoint-js-rne64-rne32-v1',
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      baseRevision: 'd031e3d318ce0cbad4755c2710c19949204784b7',
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceHashes,
      rows: allRows,
    };
    const tools = path.resolve('.tools');
    mkdirSync(tools, { recursive: true });
    const directory = mkdtempSync(path.join(tools, 'p3-mesh-projection-'));
    const temporary = path.join(directory, 'observations.tmp');
    const output = path.join(directory, 'observations.json');
    writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, output);
    const outputHash = sourceHash(path.relative(process.cwd(), output));
    console.log(`P3_MESH_PROJECTION_RECORD ${output} ${outputHash}`);

    expect(legacy.serializedDelta).toEqual([
      { n: '-1', d: '16' },
      { n: '-3', d: '64' },
    ]);
    expect(legacy.squared).toEqual(legacy.row.expectedSquared);
    expect(errors).toEqual([]);
    expect(new Set(records.map(({ id }) => id)).size).toBe(158);
    expect(records.filter(({ disposition }) => disposition === 'REQUIRED_PASS')).toHaveLength(40);
    expect(
      records.filter(({ disposition }) => disposition === 'REQUIRED_TOPOLOGY_REJECT'),
    ).toHaveLength(1);
    expect(records.filter(({ disposition }) => disposition === 'OBSERVE')).toHaveLength(117);
    for (const record of records) {
      if ('error' in (record.audit as object)) continue;
      const status = (record.audit as { status: string }).status;
      if (record.disposition === 'REQUIRED_PASS') expect(status, record.id).toBe('CERTIFIED');
      if (record.disposition === 'REQUIRED_TOPOLOGY_REJECT') {
        expect(status, record.id).toBe('TOPOLOGY_REJECTED');
        expect((record.audit as { positionPass: boolean }).positionPass, record.id).toBe(true);
        const squared = (record.audit as { maxSquared: { n: string; d: string } }).maxSquared;
        expect(BigInt(squared.n) * 256n < BigInt(squared.d), record.id).toBe(true);
      }
    }
  });

  it('pins exact scalar rounding boundaries with both signs', () => {
    for (const sign of [1n, -1n]) {
      const positive = sign > 0n;
      const zero32 = roundExact32(rational(sign, 1n << 150n));
      const zero64 = roundExact64(rational(sign, 1n << 1075n));
      expect(roundExact32(rational(sign * ((1n << 24n) + 1n), 1n << 24n))).toBe(positive ? 1 : -1);
      expect(roundExact32(rational(sign * ((1n << 24n) + 3n), 1n << 24n))).toBe(
        positive ? 1 + 2 ** -22 : -(1 + 2 ** -22),
      );
      expect(Object.is(zero32, positive ? 0 : -0)).toBe(true);
      expect(roundExact32(rational(sign * 3n, 1n << 150n))).toBe(
        positive ? 2 ** -148 : -(2 ** -148),
      );
      expect(roundExact32(rational(sign * ((1n << 24n) - 1n), 1n << 150n))).toBe(
        positive ? 2 ** -126 : -(2 ** -126),
      );
      expect(roundExact32(rational(sign * ((1n << 128n) - (1n << 104n))))).toBe(
        positive ? 2 ** 128 - 2 ** 104 : -(2 ** 128 - 2 ** 104),
      );
      expect(roundExact32(rational(sign * ((1n << 128n) - (1n << 103n))))).toBe(
        positive ? Infinity : -Infinity,
      );
      expect(roundExact64(rational(sign * ((1n << 53n) + 1n), 1n << 53n))).toBe(positive ? 1 : -1);
      expect(roundExact64(rational(sign * ((1n << 53n) + 3n), 1n << 53n))).toBe(
        positive ? 1 + 2 ** -51 : -(1 + 2 ** -51),
      );
      expect(Object.is(zero64, positive ? 0 : -0)).toBe(true);
      expect(roundExact64(rational(sign * 3n, 1n << 1075n))).toBe(
        positive ? 2 ** -1073 : -(2 ** -1073),
      );
      expect(roundExact64(rational(sign * ((1n << 53n) - 1n), 1n << 1075n))).toBe(
        positive ? 2 ** -1022 : -(2 ** -1022),
      );
      expect(roundExact64(rational(sign * ((1n << 1024n) - (1n << 971n))))).toBe(
        positive ? Number.MAX_VALUE : -Number.MAX_VALUE,
      );
      expect(roundExact64(rational(sign * ((1n << 1024n) - (1n << 970n))))).toBe(
        positive ? Infinity : -Infinity,
      );
    }
  });

  it('rejects every independently corrupted candidate stage', () => {
    const row = fixedProjectionFixtures()[0]!;
    const candidate = simulateMeshProjection(row.input);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const corruptions: readonly [string, ProjectionObservation][] = [
      ['midpoint', { ...candidate, midpoint: [candidate.midpoint[0] + 1, candidate.midpoint[1]] }],
      [
        'localOffsets',
        {
          ...candidate,
          localOffsets: [
            [candidate.localOffsets[0]![0] + 1, candidate.localOffsets[0]![1]],
            ...candidate.localOffsets.slice(1),
          ],
        },
      ],
      [
        'linear',
        {
          ...candidate,
          linear: [candidate.linear[0] + 1, ...candidate.linear.slice(1)] as [
            number,
            number,
            number,
            number,
          ],
        },
      ],
      ['anchor', { ...candidate, anchor: [candidate.anchor[0] + 1, candidate.anchor[1]] }],
      ['offset', { ...candidate, offset: [candidate.offset[0] + 1, candidate.offset[1]] }],
      ['scale', { ...candidate, scale: [candidate.scale[0] + 1, candidate.scale[1]] }],
      ['size', { ...candidate, size: [candidate.size[0] + 1, candidate.size[1]] }],
      [
        'physical',
        {
          ...candidate,
          physical: [
            [candidate.physical[0]![0] + 1, candidate.physical[0]![1]],
            ...candidate.physical.slice(1),
          ],
        },
      ],
      [
        'ndc',
        {
          ...candidate,
          ndc: [[candidate.ndc[0]![0] + 1, candidate.ndc[0]![1]], ...candidate.ndc.slice(1)],
        },
      ],
      [
        'recovered',
        {
          ...candidate,
          recovered: [
            [candidate.recovered[0]![0] + 1, candidate.recovered[0]![1]],
            ...candidate.recovered.slice(1),
          ],
        },
      ],
      [
        'recovered',
        {
          ...candidate,
          recovered: [
            [fromBits(bitsOf(candidate.recovered[0]![0]) + 1n), candidate.recovered[0]![1]],
            ...candidate.recovered.slice(1),
          ],
        },
      ],
      ['VERTEX_NDC', { ok: false, stage: 'VERTEX_NDC' }],
    ];
    for (const [field, corrupted] of corruptions)
      expect(() => auditMeshProjection(row.input, corrupted)).toThrow(`provenance:${field}`);
  });

  it('covers numerical stages, exact viewport recovery, ownership, and camera invariance', () => {
    const base = fixedProjectionFixtures()[0]!.input;
    const nonfinite = { ...base, affine: [Infinity, 0, 0, 1, 0, 0] } as ProjectionInput;
    const overflow = { ...base, affine: [Number.MAX_VALUE, 0, 0, 1, 0, 0] } as ProjectionInput;
    const underflow = { ...base, zoom: Number.MIN_VALUE } as ProjectionInput;
    const nonfiniteObservation = simulateMeshProjection(nonfinite);
    const overflowObservation = simulateMeshProjection(overflow);
    const underflowObservation = simulateMeshProjection(underflow);
    expectFailureStage(nonfiniteObservation, 'INPUT');
    expectFailureStage(overflowObservation, 'LINEAR');
    expectFailureStage(underflowObservation, 'SCALE');
    expect(() => auditMeshProjection(nonfinite, nonfiniteObservation)).toThrow('input:');
    expect(auditMeshProjection(overflow, overflowObservation)).toMatchObject({
      status: 'NUMERIC_UNRESOLVED',
      reason: 'candidate:LINEAR',
      positionPass: null,
      topologyPass: null,
      maxSquared: null,
      worstVertex: null,
    });
    expect(auditMeshProjection(underflow, underflowObservation)).toMatchObject({
      status: 'NUMERIC_UNRESOLVED',
      reason: 'candidate:SCALE',
      positionPass: null,
      topologyPass: null,
      maxSquared: null,
      worstVertex: null,
    });
    const singular = { ...base, affine: [1, 0, 2, 0, 0, 0] } as ProjectionInput;
    expect(auditMeshProjection(singular, simulateMeshProjection(singular))).toMatchObject({
      status: 'NUMERIC_UNRESOLVED',
      reason: 'singular-affine',
    });
    const viewport = {
      ...base,
      mesh: {
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        indices: [0, 1, 2],
      },
      affine: [1, 0, 0, 1, 5 * 2 ** 66, 0],
      camera: [0, 0],
      origin: [0, 0],
      zoom: 1,
      dpr: 1,
      width: 640,
      height: 360,
    } as ProjectionInput;
    const viewportCandidate = simulateMeshProjection(viewport);
    expect(auditMeshProjection(viewport, viewportCandidate).reason).toContain('viewport-not-exact');
    if (viewportCandidate.ok) {
      const forged = {
        ...viewportCandidate,
        recovered: [
          [
            fromBits(bitsOf(viewportCandidate.recovered[0]![0]) + 1n),
            viewportCandidate.recovered[0]![1],
          ] as const,
          ...viewportCandidate.recovered.slice(1),
        ],
      };
      expect(() => auditMeshProjection(viewport, forged)).toThrow('provenance:recovered');
    }
    const first = simulateMeshProjection(base);
    const changed = simulateMeshProjection({ ...base, camera: [0.125, 0.375] });
    const transformed = simulateMeshProjection({ ...base, affine: [2, 0, 0, 0.5, 9, -7] });
    expect(encoded(first.ok && changed.ok ? changed.localOffsets : null)).toEqual(
      encoded(first.ok ? first.localOffsets : null),
    );
    expect(encoded(first.ok && transformed.ok ? transformed.localOffsets : null)).toEqual(
      encoded(first.ok ? first.localOffsets : null),
    );
    if (first.ok) {
      const sourceBits = encoded(base.mesh);
      (first.recovered as Array<[number, number]>)[0]![0] += 1;
      expect(encoded(base.mesh)).toEqual(sourceBits);
    }
    const mutable = {
      ...base,
      mesh: {
        vertices: base.mesh.vertices.map(([x, y]) => [x, y] as [number, number]),
        indices: [...base.mesh.indices],
      },
    };
    const detached = simulateMeshProjection(mutable);
    const detachedBits = encoded(detached);
    mutable.mesh.vertices[0]![0] += 1;
    mutable.mesh.indices[0] = 1;
    expect(encoded(detached)).toEqual(detachedBits);

    const doubleRounding = {
      ...base,
      origin: [1 + 2 ** -24, 0] as const,
      camera: [-(2 ** -54), 0] as const,
    };
    const doubleCandidate = simulateMeshProjection(doubleRounding);
    expect(doubleCandidate.ok ? doubleCandidate.offset[0] : null).toBe(1);
    expect(doubleCandidate.ok ? doubleCandidate.offset[0] : null).not.toBe(1 + 2 ** -23);
    expect(() => auditMeshProjection(doubleRounding, doubleCandidate)).not.toThrow();

    const originSequence = fixedProjectionFixtures().filter(
      (fixture) => fixture.family === 'origin-sequence',
    );
    const originCandidates = originSequence.map((fixture) => simulateMeshProjection(fixture.input));
    expect(originCandidates.every((candidate) => candidate.ok)).toBe(true);
    const successes = originCandidates.filter(
      (candidate): candidate is Extract<ProjectionObservation, { ok: true }> => candidate.ok,
    );
    expect(successes).toHaveLength(7);
    for (const candidate of successes.slice(1)) {
      expect(encoded(candidate.localOffsets)).toEqual(encoded(successes[0]!.localOffsets));
      expect(encoded(candidate.linear)).toEqual(encoded(successes[0]!.linear));
    }
    for (const candidate of successes.slice(1, 5))
      expect(encoded(candidate.anchor)).toEqual(encoded(successes[0]!.anchor));
    expect(encoded(successes[5]!.anchor)).not.toEqual(encoded(successes[4]!.anchor));
    expect(encoded(successes[6]!.anchor)).toEqual(encoded(successes[5]!.anchor));
  });
});
