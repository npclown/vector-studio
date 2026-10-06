import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectionInput } from './mesh-projection/model.js';
import { fixedProjectionFixtures } from './mesh-projection/fixtures.js';
import { fromBits } from './rounded-fill/exact.js';
import {
  auditPackedRow,
  checkArchivedInputs,
  encodeArchivedInput,
  inputSha256,
  type ArchivedCandidate,
} from './native-projection/byte-audit.js';
import { classifyNativeProjection } from './native-projection/classify.js';
import {
  CLIP_W_WORD,
  POISON_IDENTITY_WORD,
  READBACK_BYTES,
  SENTINEL_WORD,
  ZW_TEXTURE_OFFSET,
  decodeCapture,
  texelOffset,
  type CaptureDecoding,
} from './native-projection/decode.js';
import { packNativeProjectionRow } from './native-projection/pack.js';

type ArchivedRow = Readonly<{
  kind: string;
  id: string;
  input: unknown;
  candidate: ArchivedCandidate & Readonly<{ ndc: readonly (readonly [string, string])[] }>;
  audit: Readonly<Record<string, unknown>>;
}>;
type Archive = Readonly<{ rows: readonly ArchivedRow[] }>;
type Words = readonly (readonly [number, number])[];

const archive = JSON.parse(
  readFileSync(
    path.resolve('docs/evidence/p3.1k-projection/observations-20261005T073041.json'),
    'utf8',
  ),
) as Archive;
const fixtures = fixedProjectionFixtures();
const meshRows = archive.rows.filter((row) => row.kind === 'mesh');
const TAG = (rowIndex: number) => 0x70000000 + rowIndex;
const f32View = new DataView(new ArrayBuffer(4));

function f32Word(value: number): number {
  f32View.setFloat32(0, value, true);
  return f32View.getUint32(0, true);
}

function archivedNdcWords(row: ArchivedRow): Words {
  return row.candidate.ndc.map(
    ([x, y]) => [f32Word(fromBits(BigInt(`0x${x}`))), f32Word(fromBits(BigInt(`0x${y}`)))] as const,
  );
}

function packed(rowIndex: number, captureTag = TAG(rowIndex)) {
  const result = packNativeProjectionRow(fixtures[rowIndex]!.input, rowIndex, captureTag);
  if (result.status !== 'PACKED') throw new Error(`row ${rowIndex}: ${result.stage}`);
  return result;
}

function readback(
  words: Words,
  rowIndex: number,
  captureTag: number,
  edit?: (view: DataView) => void,
): Uint8Array {
  const bytes = new Uint8Array(READBACK_BYTES);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < READBACK_BYTES; offset += 4)
    view.setUint32(offset, SENTINEL_WORD, true);
  words.forEach(([x, y], slot) => {
    const xy = texelOffset(0, slot);
    const zw = texelOffset(ZW_TEXTURE_OFFSET, slot);
    [x, y, slot, captureTag].forEach((word, lane) => view.setUint32(xy + 4 * lane, word, true));
    [0, CLIP_W_WORD, rowIndex, rowIndex].forEach((word, lane) =>
      view.setUint32(zw + 4 * lane, word, true),
    );
  });
  edit?.(view);
  return bytes;
}

function setWord(view: DataView, texture: number, slot: number, lane: number, word: number) {
  view.setUint32(texelOffset(texture, slot) + 4 * lane, word, true);
}

function clip(decoded: CaptureDecoding): Words {
  if (decoded.status !== 'CAPTURED') throw new Error(decoded.reason);
  return decoded.clipWords;
}

const triangleInput = (overrides: Partial<ProjectionInput> = {}): ProjectionInput => ({
  id: 'control/triangle',
  mesh: {
    vertices: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    indices: [0, 1, 2],
  },
  affine: [1, 0, 0, 1, 1, 1],
  camera: [0, 0],
  origin: [0, 0],
  zoom: 1,
  dpr: 1,
  width: 2,
  height: 2,
  ...overrides,
});
// width = height = 2 and translation (1, 1): reference (1, 1), (2, 1), (1, 2) recovered exactly.
const TRIANGLE_WORDS: Words = [
  [0, 0],
  [0x3f800000, 0],
  [0, 0xbf800000],
];

function importViolations(source: string, exactExports: ReadonlySet<string>): string[] {
  const allowed: Readonly<Record<string, ReadonlySet<string>>> = {
    '../mesh-projection/audit.js': new Set(['roundExact32', 'roundExact64']),
    '../mesh-projection/fixtures.js': new Set(['fixedProjectionFixtures']),
    '../conforming-mesh/oracle.js': new Set(['verifyConformingRefinement']),
    '../rounded-fill/exact.js': exactExports,
  };
  const violations: string[] = [];
  const statement = /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';/gm;
  let parsed = 0;
  for (const match of source.matchAll(statement)) {
    parsed += 1;
    const typeOnly = match[1] !== undefined;
    const names = match[2]!
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const module = match[3]!;
    if (module === '../mesh-projection/model.js') {
      if (!typeOnly || names.join() !== 'ProjectionInput') violations.push(match[0]);
      continue;
    }
    const permitted = allowed[module];
    for (const name of names) {
      const bare = name.replace(/^type\s+/, '');
      if (
        permitted === undefined ||
        !permitted.has(bare) ||
        (typeOnly && module !== '../rounded-fill/exact.js')
      )
        violations.push(`${module}:${name}`);
    }
  }
  if ((source.match(/\bimport\b/g) ?? []).length !== parsed) violations.push('unparsed import');
  if (/\brequire\s*\(|^export\s*[*{][^;]*\bfrom\b/m.test(source))
    violations.push('require/re-export');
  return violations;
}

describe('P3.1l L01 packing and byte provenance', () => {
  it('packs and independently audits all 158 corpus rows against the archived CPU lanes', () => {
    expect(fixtures).toHaveLength(158);
    let bytes = 0;
    let vertexTotal = 0;
    let triangleTotal = 0;
    fixtures.forEach((fixture, rowIndex) => {
      const row = packed(rowIndex);
      expect(row.uniform.byteLength + row.vertices.byteLength).toBe(4160);
      bytes += row.uniform.byteLength + row.vertices.byteLength;
      vertexTotal += fixture.input.mesh.vertices.length;
      triangleTotal += fixture.input.mesh.indices.length / 3;
      expect(() =>
        auditPackedRow(
          fixture.input,
          rowIndex,
          TAG(rowIndex),
          row.uniform,
          row.vertices,
          meshRows[rowIndex]!.candidate,
        ),
      ).not.toThrow();
    });
    expect([bytes, vertexTotal, triangleTotal]).toEqual([657_280, 1531, 1179]);
    expect(Math.max(...fixtures.map(({ input }) => input.mesh.vertices.length))).toBe(14);
  });

  it('rejects malformed inputs in both the packer and the auditor', () => {
    const base = fixtures[0]!.input;
    const row = packed(0);
    const candidate = meshRows[0]!.candidate;
    const cases: readonly [string, ProjectionInput, string][] = [
      ['zero vertices', { ...base, mesh: { vertices: [], indices: [0, 0, 0] } }, 'INPUT'],
      [
        '257 vertices',
        {
          ...base,
          mesh: {
            vertices: Array.from({ length: 257 }, (_, index) => [index, 0] as const),
            indices: [0, 1, 2],
          },
        },
        'INPUT',
      ],
      ['fractional index', { ...base, mesh: { ...base.mesh, indices: [0, 4.5, 5] } }, 'INPUT'],
      ['index out of range', { ...base, mesh: { ...base.mesh, indices: [0, 4, 11] } }, 'INPUT'],
      ['index count', { ...base, mesh: { ...base.mesh, indices: [0, 4, 5, 0] } }, 'INPUT'],
      [
        'nonfinite coordinate',
        {
          ...base,
          mesh: { ...base.mesh, vertices: [[NaN, 0], ...base.mesh.vertices.slice(1)] },
        },
        'INPUT',
      ],
      ['affine overflow', { ...base, affine: [Number.MAX_VALUE, 0, 0, 1, 0, 0] }, 'LINEAR'],
      ['zoom underflow', { ...base, zoom: Number.MIN_VALUE }, 'SCALE'],
      ['size above 16384', { ...base, width: 16_385 }, 'INPUT'],
    ];
    for (const [name, input, stage] of cases) {
      expect(packNativeProjectionRow(input, 0, TAG(0)), name).toEqual({
        status: 'PACK_UNRESOLVED',
        stage,
      });
      expect(
        () => auditPackedRow(input, 0, TAG(0), row.uniform, row.vertices, candidate),
        name,
      ).toThrow(`provenance:pack:${stage}`);
    }
  });

  it('rejects every corrupted blob, lane class and archived lane', () => {
    const input = fixtures[0]!.input;
    const vertexCount = input.mesh.vertices.length;
    const candidate = meshRows[0]!.candidate;
    const audit = (
      edit: (uniform: DataView, vertices: DataView) => void,
      sizes: { uniform?: number; vertices?: number } = {},
      archived: ArchivedCandidate = candidate,
    ) => {
      const row = packed(0);
      const uniform = new Uint8Array(sizes.uniform ?? 64);
      const vertices = new Uint8Array(sizes.vertices ?? 4096);
      uniform.set(row.uniform.subarray(0, uniform.length));
      vertices.set(row.vertices.subarray(0, vertices.length));
      edit(new DataView(uniform.buffer), new DataView(vertices.buffer));
      return () => auditPackedRow(input, 0, TAG(0), uniform, vertices, archived);
    };
    const flip = (view: DataView, offset: number, bit = 0) =>
      view.setUint32(offset, (view.getUint32(offset, true) ^ (1 << bit)) >>> 0, true);
    const none = () => undefined;
    expect(audit(none)).not.toThrow();
    expect(audit(none, { uniform: 63 })).toThrow('provenance:pack:uniform-length');
    expect(audit(none, { uniform: 65 })).toThrow('provenance:pack:uniform-length');
    expect(audit(none, { vertices: 4095 })).toThrow('provenance:pack:vertices-length');
    expect(audit(none, { vertices: 4097 })).toThrow('provenance:pack:vertices-length');
    expect(audit((u) => u.setUint32(56, 1, true))).toThrow('provenance:pack:reserved0');
    expect(audit((u) => u.setUint32(60, 1, true))).toThrow('provenance:pack:reserved1');
    const poison = 16 * vertexCount;
    expect(audit((_, v) => v.setUint32(4092, 0x7fc00001, true))).toThrow(
      'provenance:pack:poisonInteger',
    );
    expect(audit((_, v) => v.setUint32(poison, 0x7fc00001, true))).toThrow(
      'provenance:pack:poisonLocal',
    );
    const laneClasses: readonly [string, 'u' | 'v', number][] = [
      ['linear', 'u', 0],
      ['anchor', 'u', 16],
      ['frameOffset', 'u', 24],
      ['scale', 'u', 32],
      ['size', 'u', 44],
      ['rowIndex', 'u', 48],
      ['captureTag', 'u', 52],
      ['reserved0', 'u', 56],
      ['local', 'v', 4],
      ['vertexRowIndex', 'v', 8],
      ['vertexIndex', 'v', 12],
      ['poisonLocal', 'v', poison],
      ['poisonInteger', 'v', poison + 8],
    ];
    for (const [field, target, offset] of laneClasses)
      for (const bit of [0, 22, 31])
        expect(
          audit((u, v) => flip(target === 'u' ? u : v, offset, bit)),
          `${field}:${bit}`,
        ).toThrow(`provenance:pack:${field}`);
    // Byte-swapped size lane: 640 = 0x44200000 becomes the subnormal word 0x00002044.
    expect(audit((u) => u.setUint32(40, u.getUint32(40, true), false))).toThrow(
      'provenance:pack:size',
    );
    // Sign-flipped zeros are geometrically equal, so only the archived word comparison rejects them.
    expect(input.origin[0] - input.camera[0]).toBe(0);
    expect(audit((u) => u.setUint32(24, 0x80000000, true))).toThrow('provenance:pack:frameOffset');
    expect(input.mesh.vertices[5]).toEqual([0, 0]);
    expect(audit((_, v) => v.setUint32(16 * 5, 0x80000000, true))).toThrow('provenance:pack:local');
    expect(() =>
      auditPackedRow(input, 1, TAG(0), packed(0).uniform, packed(0).vertices, candidate),
    ).toThrow('provenance:pack:rowIndex');
    expect(() =>
      auditPackedRow(input, 0, TAG(1), packed(0).uniform, packed(0).vertices, candidate),
    ).toThrow('provenance:pack:captureTag');
    const archivedLocal = candidate.localOffsets;
    const mutated = (patch: Partial<ArchivedCandidate>) => ({ ...candidate, ...patch });
    expect(audit(none, {}, mutated({ size: ['4084000000000001', candidate.size[1]!] }))).toThrow(
      'provenance:pack:size',
    );
    expect(audit(none, {}, mutated({ offset: ['8000000000000000', '0000000000000000'] }))).toThrow(
      'provenance:pack:frameOffset',
    );
    expect(audit(none, {}, mutated({ localOffsets: archivedLocal.slice(1) }))).toThrow(
      'provenance:pack:local',
    );
  });

  it('checks archived input identity, order and bits', async () => {
    expect(() => checkArchivedInputs(fixtures, archive)).not.toThrow();
    const rows = [...archive.rows];
    const withRows = (changed: readonly unknown[]) => ({ rows: changed });
    const swapped = [rows[1]!, rows[0]!, ...rows.slice(2)];
    expect(() => checkArchivedInputs(fixtures, withRows(swapped))).toThrow(
      'provenance:archive:id:0',
    );
    const renamed = [{ ...rows[3]!, id: `${rows[3]!.id}x` }, ...rows.slice(0, 3), ...rows.slice(4)];
    expect(() => checkArchivedInputs(fixtures, withRows(renamed))).toThrow(
      'provenance:archive:id:',
    );
    const renamedInPlace = rows.map((row, index) => (index === 3 ? { ...row, id: 'other' } : row));
    expect(() => checkArchivedInputs(fixtures, withRows(renamedInPlace))).toThrow(
      'provenance:archive:id:3',
    );
    const input = encodeArchivedInput(fixtures[7]!.input);
    const bitFlipped = rows.map((row, index) =>
      index === 7 ? { ...row, input: { ...input, zoom: '3ff0000000000001' } } : row,
    );
    expect(() => checkArchivedInputs(fixtures, withRows(bitFlipped))).toThrow(
      'provenance:archive:input:7',
    );
    expect(() => checkArchivedInputs(fixtures, withRows(rows.slice(1)))).toThrow(
      'provenance:archive:count',
    );
    const mutatedFixtures = fixtures.map((fixture, index) =>
      index === 9
        ? { ...fixture, input: { ...fixture.input, camera: [0, 2 ** -1074] as const } }
        : fixture,
    );
    expect(() => checkArchivedInputs(mutatedFixtures, archive)).toThrow(
      'provenance:archive:input:9',
    );
    // inputSha256 is the SHA256 of the archived-format JSON, cross-checked against node:crypto.
    for (const index of [0, 157]) {
      const row = meshRows[index]!;
      expect(await inputSha256(fixtures[index]!.input)).toBe(
        createHash('sha256').update(JSON.stringify(row.input)).digest('hex'),
      );
    }
    expect(encodeArchivedInput({ ...fixtures[0]!.input, camera: [-0, 0] }).camera[0]).toBe(
      '8000000000000000',
    );
  });
});

describe('P3.1l L02 capture decoding', () => {
  const words: Words = [
    [0x3f000000, 0xbf000000],
    [0x7fc00000, 0x00000001],
    [0x80000000, 0xff800000],
    [0x12345678, 0x9abcdef0],
  ];
  const decode = (edit?: (view: DataView) => void, count = 4) =>
    decodeCapture(readback(words.slice(0, count), 5, 0x70000005, edit), {
      rowIndex: 5,
      expectedCount: 4,
      captureTag: 0x70000005,
    });
  const reason = (edit?: (view: DataView) => void, count = 4) => {
    const decoded = decode(edit, count);
    return decoded.status === 'CAPTURE_INVALID' ? decoded.reason : 'CAPTURED';
  };

  it('returns clip words unaltered for a valid capture', () => {
    expect(clip(decode())).toEqual(words);
    const offset = new Uint8Array(READBACK_BYTES + 8);
    offset.set(readback(words, 5, 0x70000005), 8);
    expect(
      clip(
        decodeCapture(offset.subarray(8), {
          rowIndex: 5,
          expectedCount: 4,
          captureTag: 0x70000005,
        }),
      ),
    ).toEqual(words);
  });

  it('reports every named corruption with the literal precedence', () => {
    const ZW = ZW_TEXTURE_OFFSET;
    const zero = (texture: number, slot: number) => (view: DataView) => {
      for (let lane = 0; lane < 4; lane += 1) setWord(view, texture, slot, lane, 0);
    };
    const sentinel = (texture: number, slot: number) => (view: DataView) => {
      for (let lane = 0; lane < 4; lane += 1) setWord(view, texture, slot, lane, SENTINEL_WORD);
    };
    expect(reason(sentinel(0, 2))).toBe('capture:missing:2');
    expect(reason(sentinel(ZW, 2))).toBe('capture:missing:2');
    expect(reason(undefined, 3)).toBe('capture:missing:3');
    expect(reason(zero(0, 1))).toBe('capture:zero:1');
    expect(reason(zero(ZW, 1))).toBe('capture:zero:1');
    expect(reason((v) => setWord(v, 0, 2, 2, POISON_IDENTITY_WORD))).toBe('capture:poison:2');
    expect(reason((v) => setWord(v, ZW, 2, 2, POISON_IDENTITY_WORD))).toBe('capture:poison:2');
    expect(reason((v) => setWord(v, 0, 1, 3, 0x70000004))).toBe('capture:stale:1');
    expect(reason((v) => setWord(v, ZW, 3, 3, 4))).toBe('capture:stale:3');
    expect(reason((v) => setWord(v, ZW, 3, 2, 4))).toBe('capture:stale:3');
    const swap = (view: DataView) => {
      for (let lane = 0; lane < 4; lane += 1) {
        const first = view.getUint32(texelOffset(0, 1) + 4 * lane, true);
        setWord(view, 0, 1, lane, view.getUint32(texelOffset(0, 2) + 4 * lane, true));
        setWord(view, 0, 2, lane, first);
      }
    };
    expect(reason(swap)).toBe('capture:swapped:1');
    expect(reason((v) => setWord(v, 0, 3, 2, 0))).toBe('capture:swapped:3');
    expect(reason((v) => setWord(v, 0, 2, 2, 4))).toBe('capture:identity:2');
    expect(reason((v) => setWord(v, ZW, 2, 0, 0x80000000))).toBe('capture:clip-zw:2');
    expect(reason((v) => setWord(v, ZW, 2, 1, 0x3f800001))).toBe('capture:clip-zw:2');
    expect(reason((v) => setWord(v, 0, 4, 0, 0))).toBe('capture:extra:4');
    expect(reason((v) => setWord(v, ZW, 255, 3, 5))).toBe('capture:extra:255');
    // First matching rule within a slot, and first failing slot overall.
    const both =
      (...edits: ((view: DataView) => void)[]) =>
      (view: DataView) => {
        for (const edit of edits) edit(view);
      };
    const word = (texture: number, slot: number, lane: number, value: number) => (v: DataView) => {
      setWord(v, texture, slot, lane, value);
    };
    expect(reason(both(zero(0, 2), sentinel(ZW, 2)))).toBe('capture:missing:2');
    expect(reason(both(word(0, 2, 2, POISON_IDENTITY_WORD), word(0, 2, 3, 1)))).toBe(
      'capture:poison:2',
    );
    expect(reason(both(word(0, 2, 2, 1), word(0, 2, 3, 1)))).toBe('capture:stale:2');
    expect(reason(both(word(0, 2, 2, 1), word(ZW, 2, 1, 0)))).toBe('capture:swapped:2');
    expect(reason(both(word(ZW, 3, 0, 1), word(0, 1, 2, 9)))).toBe('capture:identity:1');
    expect(
      decodeCapture(new Uint8Array(READBACK_BYTES - 4), {
        rowIndex: 5,
        expectedCount: 4,
        captureTag: 0x70000005,
      }),
    ).toEqual({ status: 'CAPTURE_INVALID', reason: 'capture:length:8188' });
  });

  it('models the native control as missing at vertexCount - 1', () => {
    const input = fixtures[0]!.input;
    const count = input.mesh.vertices.length;
    const native = archivedNdcWords(meshRows[0]!);
    expect(
      decodeCapture(readback(native.slice(0, count - 1), 0, 0x7f000000), {
        rowIndex: 0,
        expectedCount: count,
        captureTag: 0x7f000000,
      }),
    ).toEqual({ status: 'CAPTURE_INVALID', reason: `capture:missing:${count - 1}` });
  });
});

describe('P3.1l L03 classification', () => {
  it('replays all 158 archived K NDC words through decode and classify', () => {
    const fields = [
      'status',
      'positionPass',
      'topologyPass',
      'maxSquared',
      'worstVertex',
      'reason',
    ] as const;
    expect(meshRows).toHaveLength(158);
    fixtures.forEach((fixture, rowIndex) => {
      const row = meshRows[rowIndex]!;
      expect(row.id).toBe(fixture.id);
      const words = archivedNdcWords(row);
      // Archived binary64 NDC lanes must be exactly f32-representable.
      row.candidate.ndc.forEach(([x, y]) =>
        [x, y].forEach((hex) => {
          const value = fromBits(BigInt(`0x${hex}`));
          expect(Object.is(Math.fround(value), value)).toBe(true);
        }),
      );
      const decoded = decodeCapture(readback(words, rowIndex, TAG(rowIndex)), {
        rowIndex,
        expectedCount: fixture.input.mesh.vertices.length,
        captureTag: TAG(rowIndex),
      });
      const result = classifyNativeProjection(fixture.input, clip(decoded));
      expect(result, fixture.id).toEqual(
        Object.fromEntries(fields.map((field) => [field, row.audit[field]])),
      );
    });
  });

  it('classifies nonfinite, inexact viewport and singular controls without numeric fields', () => {
    const nulls = { positionPass: null, topologyPass: null, maxSquared: null, worstVertex: null };
    const input = triangleInput();
    expect(classifyNativeProjection(input, TRIANGLE_WORDS)).toMatchObject({
      status: 'CERTIFIED',
      maxSquared: { n: '0', d: '1' },
    });
    for (const word of [0x7f800000, 0xff800000, 0x7fc00000, 0xffc00001])
      expect(
        classifyNativeProjection(input, [
          TRIANGLE_WORDS[0]!,
          [TRIANGLE_WORDS[1]![0], word],
          TRIANGLE_WORDS[2]!,
        ]),
      ).toEqual({ status: 'NUMERIC_UNRESOLVED', ...nulls, reason: 'nonfinite-clip:1:1' });
    // Nonfinite precedence: an inexact recovery at vertex 0 and infinity at vertex 2.
    expect(
      classifyNativeProjection(input, [[0x00000001, 0], TRIANGLE_WORDS[1]!, [0, 0x7f800000]])
        .reason,
    ).toBe('nonfinite-clip:2:1');
    // K out-of-corpus control: nx = 2^60 makes (nx + 1) * 320 inexact in binary64.
    const far = triangleInput({
      affine: [1, 0, 0, 1, 5 * 2 ** 66, 0],
      width: 640,
      height: 360,
    });
    const nx = f32Word(2 ** 60);
    const ny = (y: number) => f32Word(Math.fround(1 - Math.fround(Math.fround(y * 2) / 360)));
    expect(
      classifyNativeProjection(far, [
        [nx, ny(0)],
        [nx, ny(0)],
        [nx, ny(1)],
      ]),
    ).toEqual({ status: 'NUMERIC_UNRESOLVED', ...nulls, reason: 'viewport-not-exact:0:0' });
    expect(
      classifyNativeProjection(triangleInput({ affine: [1, 0, 2, 0, 1, 1] }), TRIANGLE_WORDS),
    ).toEqual({ status: 'NUMERIC_UNRESOLVED', ...nulls, reason: 'singular-affine' });
    const singularRow = fixtures[0]!.input;
    expect(
      classifyNativeProjection(
        { ...singularRow, affine: [1, 0, 2, 0, 0, 0] },
        archivedNdcWords(meshRows[0]!),
      ).reason,
    ).toBe('singular-affine');
  });

  it('decodes signed zeros and subnormal words exactly', () => {
    const input = triangleInput();
    const negativeZero: Words = [[0x80000000, 0x80000000], TRIANGLE_WORDS[1]!, TRIANGLE_WORDS[2]!];
    expect(classifyNativeProjection(input, negativeZero)).toEqual(
      classifyNativeProjection(input, TRIANGLE_WORDS),
    );
    // A subnormal is not flushed: 1 + 2^-149 is not a binary64 value, so recovery is inexact.
    for (const [word, axis] of [
      [0x00000001, 0],
      [0x807fffff, 1],
    ] as const) {
      const words = TRIANGLE_WORDS.map((pair) => [...pair] as [number, number]);
      words[0]![axis] = word;
      expect(classifyNativeProjection(input, words).reason).toBe(`viewport-not-exact:0:${axis}`);
    }
  });

  it('distinguishes position, topology and reflection outcomes', () => {
    const rectangleIndex = fixtures.findIndex(({ id }) => id === 'rectangle/16x8/I/ordinary');
    const rectangle = fixtures[rectangleIndex]!.input;
    const words = archivedNdcWords(meshRows[rectangleIndex]!);
    const base = classifyNativeProjection(rectangle, words);
    expect(base.status).toBe('CERTIFIED');
    const ulp = words.map((pair, vertex) =>
      vertex === 3 ? ([pair[0] + 1, pair[1]] as const) : pair,
    );
    const ulpResult = classifyNativeProjection(rectangle, ulp);
    expect(ulpResult.maxSquared).not.toEqual(base.maxSquared);
    expect(ulpResult.status).toBe('CERTIFIED');

    // Vertex 1 is at physical (16.25, 0.5); move it toward x = 16.5 (exact dx = 65535 * 2^-18).
    const displaced = words.map((pair, vertex) =>
      vertex === 1 ? ([f32Word((2 * 16.5) / 640 - 1), pair[1]] as const) : pair,
    );
    const limited = classifyNativeProjection(rectangle, displaced);
    expect(limited).toMatchObject({
      status: 'POSITION_LIMIT',
      positionPass: false,
      topologyPass: true,
      worstVertex: 1,
      reason: 'position-limit',
    });
    expect(limited.maxSquared).toEqual({ n: '1099478073889', d: '17592186044416' });
    expect(BigInt(limited.maxSquared!.n) * 256n > BigInt(limited.maxSquared!.d)).toBe(true);

    const thinIndex = fixtures.findIndex(({ id }) => id === 'thin/collapse');
    expect(
      classifyNativeProjection(fixtures[thinIndex]!.input, archivedNdcWords(meshRows[thinIndex]!)),
    ).toMatchObject({
      status: 'TOPOLOGY_REJECTED',
      positionPass: true,
      topologyPass: false,
      reason: 'topology:orientation:0',
    });

    const reflectedIndex = fixtures.findIndex(
      ({ id }) => id === 'rectangle/16x8/reflectX/ordinary',
    );
    const reflected = fixtures[reflectedIndex]!.input;
    const reflectedWords = archivedNdcWords(meshRows[reflectedIndex]!);
    expect(reflected.affine[0]).toBe(-1);
    expect(classifyNativeProjection(reflected, reflectedWords).status).toBe('CERTIFIED');
    // Reflecting the captured x words about the frame centre flips every raw orientation.
    const mirrored = reflectedWords.map(([x, y]) => [(x ^ 0x80000000) >>> 0, y] as const);
    expect(classifyNativeProjection(reflected, mirrored)).toMatchObject({
      status: 'TOPOLOGY_REJECTED',
      positionPass: false,
      topologyPass: false,
      reason: 'topology:orientation:0',
    });
    // The positive-determinant rectangle with mirrored words is rejected the same way.
    const mirroredPositive = words.map(([x, y]) => [(x ^ 0x80000000) >>> 0, y] as const);
    expect(classifyNativeProjection(rectangle, mirroredPositive).reason).toBe(
      'topology:orientation:0',
    );
    // Orientation holds, but an unreferenced vertex captured onto vertex 0 reaches the J verifier.
    const extra = triangleInput({
      mesh: {
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ],
        indices: [0, 1, 2],
      },
    });
    expect(classifyNativeProjection(extra, [...TRIANGLE_WORDS, [0x3f800000, 0xbf800000]])).toEqual({
      status: 'CERTIFIED',
      positionPass: true,
      topologyPass: true,
      maxSquared: { n: '0', d: '1' },
      worstVertex: 0,
      reason: null,
    });
    const collapsed = classifyNativeProjection(extra, [...TRIANGLE_WORDS, TRIANGLE_WORDS[0]!]);
    expect(collapsed).toMatchObject({ status: 'TOPOLOGY_REJECTED', topologyPass: false });
    expect(collapsed.reason).toMatch(/^topology:(?!orientation)/);
  });

  it('rejects malformed inputs and clip words as row errors', () => {
    const input = triangleInput();
    expect(() =>
      classifyNativeProjection({ ...input, mesh: { vertices: [], indices: [0, 1, 2] } }, []),
    ).toThrow('input:vertex-count');
    expect(() =>
      classifyNativeProjection(
        { ...input, mesh: { ...input.mesh, indices: [0, 1, 3] } },
        TRIANGLE_WORDS,
      ),
    ).toThrow('input:index:2');
    expect(() => classifyNativeProjection({ ...input, zoom: 0 }, TRIANGLE_WORDS)).toThrow(
      'input:zoom',
    );
    expect(() => classifyNativeProjection({ ...input, height: 16_385 }, TRIANGLE_WORDS)).toThrow(
      'input:height',
    );
    expect(() =>
      classifyNativeProjection(
        { ...input, mesh: { ...input.mesh, indices: [0, 1, 2, 0, 1, 2] } },
        TRIANGLE_WORDS,
      ),
    ).toThrow(/^input:/);
    expect(() => classifyNativeProjection(input, TRIANGLE_WORDS.slice(1))).toThrow(
      'capture:clip-words',
    );
  });
});

describe('P3.1l L03 import allowlist', () => {
  it('restricts the auditor, decoder and classifier imports', () => {
    const exactExports = new Set(
      [
        ...readFileSync(path.resolve('tests/geometry/rounded-fill/exact.ts'), 'utf8').matchAll(
          /^export (?:function|const|type) (\w+)/gm,
        ),
      ].map((match) => match[1]!),
    );
    for (const file of ['byte-audit.ts', 'decode.ts', 'classify.ts'])
      expect(
        importViolations(
          readFileSync(path.resolve('tests/geometry/native-projection', file), 'utf8'),
          exactExports,
        ),
        file,
      ).toEqual([]);
    const forbidden = [
      "import { simulateMeshProjection } from '../mesh-projection/model.js';",
      "import { type ProjectionInput } from '../mesh-projection/model.js';",
      "import { auditMeshProjection } from '../mesh-projection/audit.js';",
      "import { packNativeProjectionRow } from './pack.js';",
      "import { createHash } from 'node:crypto';",
      "import * as audit from '../mesh-projection/audit.js';",
      "export { roundExact32 } from '../mesh-projection/audit.js';",
    ];
    for (const source of forbidden)
      expect(importViolations(source, exactExports), source).not.toEqual([]);
  });
});
